// End-to-end loop tests: real orchestrator + storage, in-memory IndexedDB, stubbed chrome.* and provider HTTP.
import 'fake-indexeddb/auto';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// ---- chrome.* stub (storage + keepalive call only)
const area = () => {
  let data = {};
  return {
    get: async (k) => (typeof k === 'string' ? { [k]: data[k] } : { ...data }),
    set: async (o) => { data = { ...data, ...o }; },
    remove: async (k) => { delete data[k]; },
  };
};
globalThis.chrome = { storage: { local: area(), session: area() }, runtime: { getPlatformInfo: (cb) => cb?.({}) } };

// ---- provider stub: queued model replies per vendor
const queues = { openai: [], anthropic: [] };
const calls = { openai: 0, anthropic: 0 };
const sse = (lines) => new Response(new ReadableStream({
  start(c) { const e = new TextEncoder(); for (const l of lines) c.enqueue(e.encode(l)); c.close(); },
}), { status: 200 });

globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
  if (method === 'GET' && url.includes('openai.com')) return Response.json({ data: [{ id: 'gpt-test' }] });
  if (method === 'GET' && url.includes('anthropic.com')) return Response.json({ data: [{ id: 'claude-test', display_name: 'Claude Test' }] });
  const vendor = url.includes('openai.com') ? 'openai' : 'anthropic';
  calls[vendor] += 1;
  const next = queues[vendor].shift();
  if (!next) throw new Error(`No scripted reply for ${vendor}`);
  const text = typeof next === 'string' ? next : JSON.stringify(next);
  if (vendor === 'openai') {
    return sse([
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 500 } } })}\n\n`,
    ]);
  }
  return sse([
    `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 1200 } } })}\n\n`,
    'event: ping\ndata: {}\n\n',
    `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: 'text_delta', text } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 300 } })}\n\n`,
  ]);
};

const { saveSettings, setKey } = await import('../src/storage/settings.js');
const orch = await import('../src/background/orchestrator.js');
const { get, loadConversation } = await import('../src/storage/db.js');
const { RunState: S, CompletionReason: CR, ReviewStatus, DISCLOSURE_VERSION } = await import('../src/core/constants.js');

async function configure(patch = {}) {
  await saveSettings({
    generator: { provider: 'openai', model: 'gpt-test', maxOutputTokens: 1000, contextWindow: 100000, reasoning: false, imageInput: false },
    reviewer: { provider: 'anthropic', model: 'claude-test', maxOutputTokens: 1000, contextWindow: 100000, reasoning: false, imageInput: false },
    iterationLimit: 3,
    pricing: { 'openai:gpt-test': { inputPerMTok: 1, outputPerMTok: 2 }, 'anthropic:claude-test': { inputPerMTok: 1, outputPerMTok: 2 } },
    disclosureAcks: { openai: DISCLOSURE_VERSION, anthropic: DISCLOSURE_VERSION },
    ...patch,
  });
}

async function settle(runId, until = (r) => [S.FINISHED, S.ABANDONED, S.FAILED, S.INTERRUPTED].includes(r.state)) {
  for (let i = 0; i < 400; i++) {
    const r = await get('runs', runId);
    if (until(r) && !orch.isExecuting(runId)) return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('run did not settle');
}

const G0 = { protocol_version: '1.0', summary: 'draft', response: 'Answer v0' };
const high = { provider_finding_ref: 'r1', status: 'OPEN', severity: 'HIGH', category: 'CORRECTNESS', description: 'Claim is wrong.', suggestion: 'Fix it.', material: true };
const R = (findings, status = 'ISSUES_FOUND') => ({ protocol_version: '1.0', status, summary: 'review', findings });

before(async () => {
  await setKey('openai', 'sk-test-openai-000000');
  await setKey('anthropic', 'sk-ant-test-000000');
});

test('full loop: G0 → R1 finding → G1 decision → R2 resolves → NO_MATERIAL_ISSUES, REVIEWED', async () => {
  await configure();
  queues.openai.push(G0, {
    protocol_version: '1.0', summary: 'fixed', response: 'Answer v1',
    decisions: [{ finding_id: 'PM-F-00001', decision: 'APPLIED', reason: 'Corrected the claim.' }],
  });
  queues.anthropic.push(R([high]), R([{ existing_finding_id: 'PM-F-00001', status: 'RESOLVED' }], 'NO_MATERIAL_ISSUES'));
  const { runId, conversationId } = await orch.submitPrompt({ prompt: 'Explain X', capUsd: 5 });
  const run = await settle(runId);
  assert.equal(run.state, S.FINISHED);
  assert.equal(run.completionReason, CR.NO_MATERIAL_ISSUES);
  assert.equal(run.reviewStatus, ReviewStatus.REVIEWED);
  const data = await loadConversation(conversationId);
  assert.equal(data.findings[0].status, 'RESOLVED');
  assert.equal(data.operations.length, 4);
  assert.ok(data.operations.every((o) => o.costUsd > 0));
  assert.equal(data.messages.find((m) => m.id === run.latestOutputMessageId).text, 'Answer v1');
  // a new prompt is now allowed in the same conversation (conversation lock released)
  assert.equal(await get('meta', 'globalLock'), undefined);
});

test('limit 0: G0 + closing review only; material finding → MAX_ITERATIONS_REACHED (AC-07)', async () => {
  await configure({ iterationLimit: 0 });
  queues.openai.push(G0);
  queues.anthropic.push(R([high]));
  const { runId } = await orch.submitPrompt({ prompt: 'p', capUsd: 5 });
  const run = await settle(runId);
  assert.equal(run.completionReason, CR.MAX_ITERATIONS_REACHED);
  assert.equal(run.reviewStatus, ReviewStatus.LAST_REVIEWED_MATERIAL_REMAIN);
});

test('omission → one corrective retry → second omission FAILED; retry passes PREFLIGHT and continues (AC-18, AC-26)', async () => {
  await configure({ iterationLimit: 1 });
  queues.openai.push(G0, {
    protocol_version: '1.0', summary: 's', response: 'v1',
    decisions: [{ finding_id: 'PM-F-00001', decision: 'APPLIED', reason: 'done' }],
  });
  queues.anthropic.push(R([high]), R([], 'NO_MATERIAL_ISSUES'), R([], 'NO_MATERIAL_ISSUES'));
  const { runId, conversationId } = await orch.submitPrompt({ prompt: 'p', capUsd: 5 });
  let run = await settle(runId);
  assert.equal(run.state, S.FAILED);
  assert.match(run.failure.message, /invalid response twice/);
  const before = await loadConversation(conversationId);
  const f = before.findings.find((x) => x.status !== 'RESOLVED');
  assert.ok(f, 'omitted finding is never closed');

  queues.anthropic.push(R([{ existing_finding_id: f.id, status: 'RESOLVED' }], 'NO_MATERIAL_ISSUES'));
  await orch.retry(runId);
  run = await settle(runId);
  assert.equal(run.completionReason, CR.NO_MATERIAL_ISSUES);
  assert.ok(run.log.some((l) => l.type === 'TRANSITION' && l.from === S.FAILED && l.to === S.PREFLIGHT));
  const after = await loadConversation(conversationId);
  // no duplicate output messages from the retry (AC-37)
  assert.equal(after.messages.filter((m) => m.kind === 'g_output').length, 2);
});

test('budget reserve fails before initial G → BUDGET_REACHED with no output (§9.3)', async () => {
  await configure();
  const n = calls.openai;
  const { runId } = await orch.submitPrompt({ prompt: 'p', capUsd: 0.0001 });
  const run = await settle(runId);
  assert.equal(run.completionReason, CR.BUDGET_REACHED);
  assert.equal(run.reviewStatus, null);
  assert.equal(calls.openai, n, 'no provider call was made');
});

test('same-vendor configuration is blocked at pre-flight (AC-02)', async () => {
  await configure({ reviewer: { provider: 'openai', model: 'gpt-test', maxOutputTokens: 1000, contextWindow: 100000 } });
  const { runId } = await orch.submitPrompt({ prompt: 'p', capUsd: 5 });
  const run = await settle(runId);
  assert.equal(run.state, S.FAILED);
  assert.match(run.failure.message, /different vendors/);
  await orch.abandon(runId);
  assert.equal((await get('runs', runId)).abandonmentReason, 'USER_ABANDONED_AFTER_FAILURE');
});

test('missing pricing fails pre-flight with PRICING action; proceeding unenforced works (FR-081)', async () => {
  await configure({ pricing: {} });
  queues.openai.push(G0);
  queues.anthropic.push(R([], 'NO_MATERIAL_ISSUES'));
  const { runId, conversationId } = await orch.submitPrompt({ prompt: 'p', capUsd: 5 });
  let run = await settle(runId);
  assert.equal(run.pendingAction, 'PRICING');
  await orch.disableBudgetEnforcement(conversationId);
  await orch.retry(runId);
  run = await settle(runId);
  assert.equal(run.completionReason, CR.NO_MATERIAL_ISSUES);
  const data = await loadConversation(conversationId);
  assert.ok(data.operations.every((o) => o.costUsd === null)); // "Not available", never invented
});

test('restart recovery: RUNNING → INTERRUPTED, in-flight op UNKNOWN, resume requires approval (AC-32, AC-33)', async () => {
  await configure();
  const { put, tx } = await import('../src/storage/db.js');
  // Simulate a run that was RUNNING with an in-flight op when the worker died.
  queues.openai.push(G0);
  queues.anthropic.push(R([], 'NO_MATERIAL_ISSUES'));
  const { runId } = await orch.submitPrompt({ prompt: 'p', capUsd: 5 });
  await settle(runId);
  const run = await get('runs', runId);
  await put('runs', { ...run, state: S.RUNNING, completionReason: null });
  await put('operations', { id: 'op-x', conversationId: run.conversationId, runId, state: 'IN_PROGRESS', createdAt: new Date().toISOString(), error: null });
  await tx(['meta'], 'readwrite', (s) => s.meta.put({ key: 'globalLock', runId }));
  await orch.recoverOnStartup();
  assert.equal((await get('runs', runId)).state, S.INTERRUPTED);
  assert.equal((await get('operations', 'op-x')).state, 'UNKNOWN');
  assert.equal(await get('meta', 'globalLock'), undefined);
  const r = await orch.resume(runId);
  assert.equal(r.needsApproval, true);
  await orch.abandon(runId);
  assert.equal((await get('runs', runId)).abandonmentReason, 'USER_ABANDONED_AFTER_INTERRUPTION');
});
