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
let lastBody = null;
const bodies = { openai: [], anthropic: [] };
const calls = { openai: 0, anthropic: 0 };
const sse = (lines) => new Response(new ReadableStream({
  start(c) { const e = new TextEncoder(); for (const l of lines) c.enqueue(e.encode(l)); c.close(); },
}), { status: 200 });

globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
  if (method === 'GET' && url.includes('openai.com')) return Response.json({ data: [{ id: 'gpt-test' }, { id: 'whisper-1' }, { id: 'gpt-5.1' }] });
  if (method === 'GET' && url.includes('anthropic.com')) return Response.json({ data: [{ id: 'claude-test', display_name: 'Claude Test' }, { id: 'claude-sonnet-4-5' }] });
  lastBody = body;
  const vendor = url.includes('openai.com') ? 'openai' : 'anthropic';
  bodies[vendor].push(JSON.parse(body));
  calls[vendor] += 1;
  const next = queues[vendor].shift();
  if (!next) throw new Error(`No scripted reply for ${vendor}`);
  if (next.streamError) return sse([`data: ${next.streamError}\n\n`]); // provider error mid-stream
  // { searchedReply, sourceUrl }: a reply preceded by one web search and followed by a citation
  // { image, imageReply }: a generated image (base64) followed by imageReply (object, or raw text)
  const searched = next.searchedReply;
  const text = next.image ? (typeof next.imageReply === 'string' ? next.imageReply : JSON.stringify(next.imageReply)) : JSON.stringify(searched || next);
  if (vendor === 'openai') {
    const imageItem = next.image ? { id: `ig_${calls.openai}`, type: 'image_generation_call', status: 'completed', result: next.image } : null;
    return sse([
      ...(imageItem ? [
        `data: ${JSON.stringify({ type: 'response.image_generation_call.in_progress' })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.output_item.done', item: imageItem })}\n\n`,
      ] : []),
      ...(searched ? [
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Let me look that up.' })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.web_search_call.completed' })}\n\n`,
      ] : []),
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`,
      ...(searched ? [`data: ${JSON.stringify({ type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: next.sourceUrl, title: 'Live source' } })}\n\n`] : []),
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
// The extension fetches tools.json from its package; here the real file is read from disk.
const { loadToolRegistry } = await import('../src/providers/tools.js');
const { readFileSync } = await import('node:fs');
await loadToolRegistry(async () => JSON.parse(readFileSync(new URL('../src/providers/tools.json', import.meta.url), 'utf8')));
const orch = await import('../src/background/orchestrator.js');
const { get, loadConversation } = await import('../src/storage/db.js');
const { RunState: S, CompletionReason: CR, ReviewStatus, DISCLOSURE_VERSION } = await import('../src/core/constants.js');

async function configure(patch = {}) {
  await saveSettings({
    generator: { provider: 'openai', model: 'gpt-test', maxOutputTokens: 1000, contextWindow: 100000 },
    reviewer: { provider: 'anthropic', model: 'claude-test', maxOutputTokens: 1000, contextWindow: 100000, extendedThinking: false },
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

test('pre-flight blocks a listed but unsupported model, and a model the key cannot access', async () => {
  await configure({ generator: { provider: 'openai', model: 'whisper-1', maxOutputTokens: 1000, contextWindow: 100000 } });
  let { runId } = await orch.submitPrompt({ prompt: 'p', capUsd: 5 });
  let run = await settle(runId);
  assert.match(run.failure.message, /not supported by PeerMind/);
  await orch.abandon(runId);

  await configure({ generator: { provider: 'openai', model: 'gpt-not-on-this-key', maxOutputTokens: 1000, contextWindow: 100000 } });
  ({ runId } = await orch.submitPrompt({ prompt: 'p', capUsd: 5 }));
  run = await settle(runId);
  assert.equal(run.failure.message, 'Generator · OpenAI gpt-not-on-this-key: model is not available with this API key.');
  await orch.abandon(runId);
});

test('images are blocked at pre-flight when a selected model has no detected image input', async () => {
  await configure();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
  const { runId } = await orch.submitPrompt({ prompt: 'describe', images: [{ media_type: 'image/png', base64: png }], capUsd: 5 });
  const run = await settle(runId);
  assert.match(run.failure.message, /does not accept image input/); // gpt-test / claude-test are not image models
  await orch.abandon(runId);
});

test('built-in default prices let a run start with no pricing entered, and costs are recorded', async () => {
  await configure({
    pricing: {},
    generator: { provider: 'openai', model: 'gpt-5.1', maxOutputTokens: 1000, contextWindow: 100000 },
    reviewer: { provider: 'anthropic', model: 'claude-sonnet-4-5', maxOutputTokens: 4000, contextWindow: 100000, extendedThinking: true },
  });
  queues.openai.push(G0);
  queues.anthropic.push(R([], 'NO_MATERIAL_ISSUES'));
  const { runId, conversationId } = await orch.submitPrompt({ prompt: 'p', capUsd: 5 });
  const run = await settle(runId);
  assert.equal(run.completionReason, CR.NO_MATERIAL_ISSUES);
  assert.equal(run.config.pricingG.source, 'default');
  assert.equal(run.config.reviewer.reasoning, true); // Sonnet 4.5 + extended thinking opted in
  assert.deepEqual(JSON.parse(lastBody).thinking, { type: 'enabled', budget_tokens: 2000 });
  const data = await loadConversation(conversationId);
  assert.ok(data.operations.every((o) => o.costUsd > 0));
});

test('a provider error is shown raw, prefixed with the role and model that failed', async () => {
  await configure();
  const raw = '{"type":"error","sequence_number":2,"error":{"message":"You have no credits remaining.","type":"insufficient_quota","code":"credit_balance_exhausted"}}';
  queues.openai.push({ streamError: raw });
  const { runId } = await orch.submitPrompt({ prompt: 'p', capUsd: 5 });
  const run = await settle(runId);
  assert.equal(run.state, S.FAILED);
  assert.equal(run.failure.message, `Generator · OpenAI gpt-test: ${raw}`);
  await orch.abandon(runId);
});

test('web search: sent to both roles when allowed; preamble dropped, sources and search fee recorded', async () => {
  await configure({
    pricing: {},
    generator: { provider: 'openai', model: 'gpt-5.1', maxOutputTokens: 1000, contextWindow: 100000 },
    reviewer: { provider: 'anthropic', model: 'claude-sonnet-4-5', maxOutputTokens: 4000, contextWindow: 100000 },
  });
  bodies.openai.length = 0;
  bodies.anthropic.length = 0;
  queues.openai.push({ searchedReply: { protocol_version: '1.0', summary: 'live', response: 'NVDA is $148.52' }, sourceUrl: 'https://finance.example/nvda' });
  queues.anthropic.push(R([], 'NO_MATERIAL_ISSUES'));
  const { runId, conversationId } = await orch.submitPrompt({ prompt: 'NVIDIA price today?', capUsd: 5 });
  const run = await settle(runId);
  assert.equal(run.completionReason, CR.NO_MATERIAL_ISSUES);
  assert.deepEqual(bodies.openai[0].tools, [{ type: 'web_search' }]);
  assert.equal(bodies.anthropic[0].tools[0].name, 'web_search');
  const data = await loadConversation(conversationId);
  const out = data.messages.find((m) => m.kind === 'g_output');
  assert.equal(out.text, 'NVDA is $148.52'); // "Let me look that up." preamble discarded
  assert.deepEqual(out.sources, [{ url: 'https://finance.example/nvda', title: 'Live source' }]);
  const gOp = data.operations.find((o) => o.role === 'G');
  assert.equal(gOp.usage.webSearches, 1);
  assert.ok(Math.abs(gOp.costUsd - ((1000 * 1.25 + 500 * 10) / 1e6 + 0.01)) < 1e-9); // tokens + one search

  // Turning web search off for the conversation removes the tool from the next run.
  await orch.updateConversation(conversationId, { webSearch: false });
  queues.openai.push(G0);
  queues.anthropic.push(R([], 'NO_MATERIAL_ISSUES'));
  const second = await orch.submitPrompt({ conversationId, prompt: 'Explain it', capUsd: 5 });
  await settle(second.runId);
  assert.equal(bodies.openai[1].tools, undefined);
  assert.equal(bodies.anthropic[1].tools, undefined);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]).toString('base64');
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]).toString('base64');
const imageSetup = (reviewerModel = 'claude-sonnet-4-5') => configure({
  pricing: { 'anthropic:claude-test': { inputPerMTok: 1, outputPerMTok: 2 } }, iterationLimit: 1,
  generator: { provider: 'openai', model: 'gpt-5.1', maxOutputTokens: 1000, contextWindow: 100000 },
  reviewer: { provider: 'anthropic', model: reviewerModel, maxOutputTokens: 4000, contextWindow: 100000 },
});

test('image generation: draw → Reviewer sees the image → refine edits it → closing review', async () => {
  await imageSetup();
  bodies.openai.length = 0;
  bodies.anthropic.length = 0;
  const style = { provider_finding_ref: 's1', status: 'OPEN', severity: 'MEDIUM', category: 'REQUIREMENT_GAP', description: 'Not cartoon style.', suggestion: 'Use flat cartoon shading.', material: true };
  queues.openai.push(
    { image: PNG, imageReply: { protocol_version: '1.0', summary: 'cat', response: 'A cat sitting.' } },
    { image: PNG2, imageReply: { protocol_version: '1.0', summary: 'cartoon', response: 'A cartoon cat.', decisions: [{ finding_id: 'PM-F-00001', decision: 'APPLIED', reason: 'Redrew in cartoon style.' }] } },
  );
  queues.anthropic.push(R([style]), R([{ existing_finding_id: 'PM-F-00001', status: 'RESOLVED' }], 'NO_MATERIAL_ISSUES'));

  const { runId, conversationId } = await orch.submitPrompt({ prompt: 'generate cartoon type cat image', capUsd: 5, tools: { image_generation: true, web_search: false } });
  const run = await settle(runId);
  assert.equal(run.completionReason, CR.NO_MATERIAL_ISSUES);

  // Generator was offered only the image tool (web search switched off); Reviewer got no image tool.
  assert.deepEqual(bodies.openai[0].tools, [{ type: 'image_generation', size: '1024x1024', quality: 'medium', output_format: 'png', action: 'auto' }]);
  assert.equal(bodies.anthropic[0].tools, undefined);
  // Reviewer received the actual image bytes.
  assert.ok(bodies.anthropic[0].messages[0].content.some((c) => c.type === 'image' && c.source.data === PNG));
  // The refinement received the previous image to edit.
  assert.ok(bodies.openai[1].input[0].content.some((c) => c.type === 'input_image' && c.image_url.endsWith(PNG)));

  const data = await loadConversation(conversationId);
  const outs = data.messages.filter((m) => m.kind === 'g_output');
  assert.equal(outs[0].assets[0].operation, 'GENERATED');
  assert.equal(outs[1].assets[0].operation, 'EDITED');
  assert.equal(outs[1].assets[0].source_asset_id, outs[0].assets[0].asset_id); // version chain
  assert.equal(data.assets.length, 2);
  assert.match(data.assets[0].sha256, /^[0-9a-f]{64}$/);
  const gOp = data.operations.find((o) => o.role === 'G');
  assert.equal(gOp.usage.images, 1);
  assert.ok(Math.abs(gOp.costUsd - ((1000 * 1.25 + 500 * 10) / 1e6 + 0.06)) < 1e-9); // tokens + one image fee
});

test('image generation: invalid JSON after drawing is fixed without drawing again', async () => {
  await imageSetup();
  bodies.openai.length = 0;
  queues.openai.push(
    { image: PNG, imageReply: 'Here is your cat!' },                                   // image ok, text not JSON
    { protocol_version: '1.0', summary: 'cat', response: 'A cat.' },                    // corrective retry
  );
  queues.anthropic.push(R([], 'NO_MATERIAL_ISSUES'));
  const { runId, conversationId } = await orch.submitPrompt({ prompt: 'draw a cat', capUsd: 5, tools: { image_generation: true, web_search: false } });
  const run = await settle(runId);
  assert.equal(run.completionReason, CR.NO_MATERIAL_ISSUES);
  assert.equal(bodies.openai[1].tools, undefined); // retry is not offered the image tool
  assert.match(JSON.stringify(bodies.openai[1].input), /has been kept/);
  const data = await loadConversation(conversationId);
  assert.equal(data.assets.length, 1); // the first image was kept, nothing redrawn
  assert.equal(data.messages.find((m) => m.kind === 'g_output').assets.length, 1);
});

test('image generation: a Reviewer that cannot read images stops with a clear message', async () => {
  await imageSetup('claude-test'); // no image input detected for this model
  queues.openai.push({ image: PNG, imageReply: { protocol_version: '1.0', summary: 'cat', response: 'A cat.' } });
  const { runId } = await orch.submitPrompt({ prompt: 'draw a cat', capUsd: 5, tools: { image_generation: true, web_search: false } });
  const run = await settle(runId);
  assert.equal(run.state, S.FAILED);
  assert.match(run.failure.message, /^Reviewer · Anthropic claude-test: the answer contains generated image\(s\), but this model cannot read images/);
  await orch.abandon(runId);
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
