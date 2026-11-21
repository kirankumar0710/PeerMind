// §2, §5, §9, §10.2, §11: run lifecycle and the Generate → Review → Refine loop.
// Lives in the service worker (FR-041). Every state change is persisted before the next provider call.
import {
  RunState as S, CompletionReason as CR, OpState, OpKind, FindingStatus as FS,
  ReviewStatus, DOWNGRADE_LABEL, ITERATION_LIMIT, DISCLOSURE_VERSION,
} from '../core/constants.js';
import { assertTransition, holdsGlobalLock, isTerminal, stopOutcome, TransitionError } from '../core/state-machine.js';
import { parseStrictJson, validateInitialG, validateRefinement } from '../core/protocol.js';
import { applyReviewReport } from '../core/findings.js';
import { buildRequest, correctiveMessage } from '../core/context.js';
import { checkReserve, costUsd, hasPricing } from '../core/budget.js';
import { uid, nowIso, formatAssetId, sha256Hex, base64ToBytes, bytesToBase64, MEDIA_EXT } from '../core/util.js';
import { ADAPTERS, vendorOf } from '../providers/adapters.js';
import { streamCall, ProviderError } from '../providers/transport.js';
import { tx, get, put, findingKey } from '../storage/db.js';
import { getSettings, getKey, pricingKey } from '../storage/settings.js';
import { acquireKeepalive } from './keepalive.js';

const active = new Map(); // runId -> AbortController for the in-flight drive loop
const listeners = new Set();
let seqCounter = 0;
const nextSeq = () => Date.now() * 1000 + (seqCounter++ % 1000);

export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (evt) => { for (const fn of listeners) { try { fn(evt); } catch { /* listener errors never break runs */ } } };

const log = (run, entry) => { run.log = [...(run.log || []), { at: nowIso(), ...entry }].slice(-200); };

// ------------------------------------------------------------------ transitions & locks

/**
 * Atomically move a run to `to`, enforcing §5.3, and keep the global lock (§5.4) consistent.
 * Entering PREFLIGHT acquires the global lock; if another run holds it the run is left as-is
 * and marked waiting. Returns the updated run, or null when the lock was busy.
 */
async function transition(runId, to, patch = {}) {
  const result = await tx(['runs', 'meta'], 'readwrite', async (s) => {
    const run = await s.runs.get(runId);
    const from = run.state;
    try {
      assertTransition(from, to);
    } catch (e) {
      if (e instanceof TransitionError) {
        log(run, { type: 'REJECTED_TRANSITION', from, to });
        await s.runs.put(run);
      }
      throw e;
    }
    const lock = await s.meta.get('globalLock');
    if (to === S.PREFLIGHT || (to === S.RUNNING && !holdsGlobalLock(from))) {
      if (lock && lock.runId !== runId) {
        const holder = await s.runs.get(lock.runId);
        if (holder && holdsGlobalLock(holder.state)) {
          run.waitingForLock = true;
          await s.runs.put(run);
          return { busy: true, run };
        }
      }
      await s.meta.put({ key: 'globalLock', runId });
    }
    if (holdsGlobalLock(from) && !holdsGlobalLock(to) && lock?.runId === runId) await s.meta.delete('globalLock');
    if (to === S.PREFLIGHT) patch = { preflightFrom: from, ...patch };
    Object.assign(run, patch, { state: to, updatedAt: nowIso(), waitingForLock: false });
    log(run, { type: 'TRANSITION', from, to });
    await s.runs.put(run);
    return { busy: false, run, from };
  });
  emit({ type: 'run', runId, conversationId: result.run.conversationId });
  if (result.busy) return null;
  if (holdsGlobalLock(result.from) && !holdsGlobalLock(to)) queueMicrotask(startWaitingRun);
  if ([S.PAUSED_WAITING_FOR_USER, S.INTERRUPTED, S.FAILED].includes(to)) emit({ type: 'needsUser', run: result.run });
  return result.run;
}

/** When the global lock frees up, start the oldest run that was waiting for it. */
async function startWaitingRun() {
  const runs = await tx(['runs'], 'readonly', (s) => s.runs.all());
  const next = runs.filter((r) => r.waitingForLock && !isTerminal(r.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
  if (next) requestExecution(next.id).catch(() => {});
}

// ------------------------------------------------------------------ public API

/** Submit a prompt (§2): creates the conversation if needed, enforces the conversation lock (FR-049). */
export async function submitPrompt({ conversationId, prompt, images = [], capUsd }) {
  if (!prompt?.trim() && !images.length) throw new Error('Enter a prompt or attach an image.');
  const settings = await getSettings();
  const assetRecords = [];
  for (const img of images) {
    if (!MEDIA_EXT[img.media_type]) throw new Error(`Unsupported image type ${img.media_type}.`);
    const bytes = base64ToBytes(img.base64);
    assetRecords.push({ media_type: img.media_type, bytes, sha256: await sha256Hex(bytes), byte_length: bytes.byteLength });
  }

  const run = await tx(['conversations', 'runs', 'messages', 'assets'], 'readwrite', async (s) => {
    let conv = conversationId ? await s.conversations.get(conversationId) : null;
    if (conversationId && !conv) throw new Error('Conversation not found.');
    if (!conv) {
      conv = {
        id: uid('conv'), title: (prompt || 'Image prompt').slice(0, 60), createdAt: nowIso(), updatedAt: nowIso(),
        capUsd: Number.isFinite(capUsd) ? capUsd : settings.defaultCapUsd, budgetEnforced: true,
        readOnly: false, nextFindingNumber: 1, nextAssetNumber: 1,
      };
    }
    if (conv.readOnly) throw new Error('This conversation is read-only for provider calls.');
    const runs = await s.runs.byIndex('conversationId', conv.id);
    if (runs.some((r) => !isTerminal(r.state))) throw new Error('This conversation already has an unfinished run. Finish or abandon it first.');

    const runId = uid('run');
    const assetIds = [];
    for (const a of assetRecords) {
      const id = formatAssetId(conv.nextAssetNumber++);
      assetIds.push(id);
      // User attachments are recorded as operation "UPLOADED" (§8.2 only names GENERATED/EDITED; spec gap).
      await s.assets.put({
        key: findingKey(conv.id, id), conversationId: conv.id, asset_id: id, media_type: a.media_type,
        operation: 'UPLOADED', source_asset_id: null, sha256: a.sha256, byte_length: a.byte_length, bytes: a.bytes,
      });
    }
    const msg = { id: uid('msg'), conversationId: conv.id, runId, seq: nextSeq(), kind: 'user', text: prompt || '', assetIds, createdAt: nowIso() };
    await s.messages.put(msg);
    const r = {
      id: runId, conversationId: conv.id, prompt: prompt || '', promptMessageId: msg.id, imageAssetIds: assetIds,
      state: S.CREATED, completionReason: null, abandonmentReason: null, preflightFrom: null,
      createdAt: nowIso(), updatedAt: nowIso(), config: null,
      cursor: { kind: OpKind.G_INITIAL, refinementsDone: 0, reviewNo: 0 },
      latestOutputMessageId: null, latestOutputReviewed: false, lastReportOpenIds: [],
      downgrades: [], reviewStatus: null, reviewLabels: [], finalOutputReviewed: false,
      failure: null, pendingAction: null, waitingForLock: false, log: [],
    };
    await s.runs.put(r);
    conv.updatedAt = nowIso();
    await s.conversations.put(conv);
    return r;
  });
  emit({ type: 'conversation', conversationId: run.conversationId });
  await requestExecution(run.id);
  return { conversationId: run.conversationId, runId: run.id };
}

/** Enter PREFLIGHT (acquiring the global lock), validate, then run. Used by start, retry and resume. */
export async function requestExecution(runId) {
  const entered = await transition(runId, S.PREFLIGHT, { failure: null, pendingAction: null });
  if (!entered) return { waiting: true };
  const problem = await preflight(entered).catch((e) => ({ message: e.message, action: null }));
  if (problem) {
    await transition(runId, S.FAILED, { failure: { stage: 'PREFLIGHT', message: problem.message }, pendingAction: problem.action });
    return { failed: problem };
  }
  const run = await get('runs', runId);
  if (run.state !== S.PREFLIGHT) return { stopped: true }; // abandoned during pre-flight
  await transition(runId, S.RUNNING);
  drive(runId);
  return { started: true };
}

/** §5.4 Stop. RUNNING → FINISHED/USER_STOPPED; other non-terminal states → ABANDONED. */
export async function stop(runId) {
  const run = await get('runs', runId);
  const outcome = stopOutcome(run.state, run.preflightFrom);
  if (!outcome) return;
  if (run.state === S.RUNNING && active.has(runId)) {
    active.get(runId).abort(new ProviderError('aborted', 'Stopped by user.'));
    return; // drive() finishes the run with USER_STOPPED and preserves partial output
  }
  if (outcome.to === S.FINISHED) return finishRun(runId, CR.USER_STOPPED);
  await transition(runId, S.ABANDONED, { abandonmentReason: outcome.abandonmentReason });
  await releaseConversation(run.conversationId);
}

/** FAILED → PREFLIGHT (FR-033). */
export async function retry(runId) {
  const run = await get('runs', runId);
  if (run.state !== S.FAILED && run.state !== S.PAUSED_WAITING_FOR_USER) throw new Error(`Cannot retry a run in ${run.state}.`);
  return requestExecution(runId);
}

/** INTERRUPTED → PREFLIGHT (FR-089). UNKNOWN operations need explicit approval first (FR-046). */
export async function resume(runId, { approveUnknown = false } = {}) {
  const run = await get('runs', runId);
  if (run.state !== S.INTERRUPTED) throw new Error(`Cannot resume a run in ${run.state}.`);
  const ops = await tx(['operations'], 'readonly', (s) => s.operations.byIndex('runId', runId));
  const unknown = ops.filter((o) => o.state === OpState.UNKNOWN && !o.retryApproved);
  if (unknown.length && !approveUnknown) {
    return { needsApproval: true, unknownOps: unknown.map((o) => o.id) };
  }
  if (unknown.length) {
    await tx(['operations'], 'readwrite', async (s) => {
      for (const o of unknown) await s.operations.put({ ...o, retryApproved: true, retryApprovedAt: nowIso() });
    });
  }
  return requestExecution(runId);
}

export const abandon = stop;

/** §9.4 option 2: proceed with budget enforcement disabled for this conversation, after explicit confirmation. */
export async function disableBudgetEnforcement(conversationId) {
  await tx(['conversations'], 'readwrite', async (s) => {
    const c = await s.conversations.get(conversationId);
    c.budgetEnforced = false;
    await s.conversations.put(c);
  });
  emit({ type: 'conversation', conversationId });
}

/** §9.5 BUDGET_REACHED recovery. */
export async function updateConversation(conversationId, patch) {
  const allowed = {};
  if (Number.isFinite(patch.capUsd) && patch.capUsd >= 0) allowed.capUsd = patch.capUsd;
  if (typeof patch.readOnly === 'boolean') allowed.readOnly = patch.readOnly;
  await tx(['conversations'], 'readwrite', async (s) => {
    const c = await s.conversations.get(conversationId);
    await s.conversations.put({ ...c, ...allowed, updatedAt: nowIso() });
  });
  emit({ type: 'conversation', conversationId });
}

export const isExecuting = (runId) => active.has(runId);

// ------------------------------------------------------------------ restart recovery (§5.6)

/**
 * Called when the service worker starts. Any run that was mid-execution lost continuity:
 * RUNNING → INTERRUPTED, PREFLIGHT → FAILED (PREFLIGHT cannot go to INTERRUPTED per §5.3).
 * In-flight operations are classified. Nothing is resumed automatically (FR-044).
 */
export async function recoverOnStartup() {
  const runs = await tx(['runs'], 'readonly', (s) => s.runs.all());
  for (const run of runs) {
    if (run.state !== S.RUNNING && run.state !== S.PREFLIGHT) continue;
    if (active.has(run.id)) continue;
    await tx(['operations'], 'readwrite', async (s) => {
      for (const op of await s.operations.byIndex('runId', run.id)) {
        if (op.state !== OpState.IN_PROGRESS) continue;
        // A recorded result is SUCCEEDED (its step is re-run on resume; the result is not reused yet);
        // a recorded error is a definitive failure; otherwise the provider may have completed remotely.
        const state = op.rawResult != null ? OpState.SUCCEEDED : op.error ? OpState.FAILED : OpState.UNKNOWN;
        await s.operations.put({ ...op, state, endedAt: nowIso(), classifiedOnRestart: true });
      }
    });
    if (run.state === S.RUNNING) {
      await transition(run.id, S.INTERRUPTED, { failure: { stage: 'EXECUTION', message: 'Execution was interrupted (worker or browser restart).' } });
    } else {
      await transition(run.id, S.FAILED, { failure: { stage: 'PREFLIGHT', message: 'Pre-flight was interrupted.' } });
    }
  }
  // Clear a stale global lock whose holder is no longer executing.
  await tx(['meta', 'runs'], 'readwrite', async (s) => {
    const lock = await s.meta.get('globalLock');
    if (!lock) return;
    const holder = await s.runs.get(lock.runId);
    if (!holder || !holdsGlobalLock(holder.state)) await s.meta.delete('globalLock');
  });
}

// ------------------------------------------------------------------ pre-flight (§6.3)

async function preflight(run) {
  const settings = await getSettings();
  const conv = await get('conversations', run.conversationId);
  const g = settings.generator;
  const r = settings.reviewer;

  if (!ADAPTERS[g.provider] || !ADAPTERS[r.provider]) return { message: 'Select a Generator and a Reviewer provider.' };
  if (vendorOf(g.provider) === vendorOf(r.provider)) {
    return { message: 'Generator and Reviewer must come from different vendors (FR-004).', action: 'SETTINGS' };
  }
  if (!g.model || !r.model) return { message: 'Select a model for both roles.', action: 'SETTINGS' };
  const limit = settings.iterationLimit;
  if (!Number.isInteger(limit) || limit < ITERATION_LIMIT.min || limit > ITERATION_LIMIT.max) {
    return { message: `Iteration limit must be an integer ${ITERATION_LIMIT.min}–${ITERATION_LIMIT.max}.`, action: 'SETTINGS' };
  }
  for (const [role, cfg] of [['Generator', g], ['Reviewer', r]]) {
    if (!Number.isInteger(cfg.maxOutputTokens) || cfg.maxOutputTokens < 256) return { message: `${role} max output tokens must be an integer ≥ 256.`, action: 'SETTINGS' };
    if (!Number.isInteger(cfg.contextWindow) || cfg.contextWindow <= cfg.maxOutputTokens) return { message: `${role} context window must exceed its max output tokens.`, action: 'SETTINGS' };
  }
  for (const p of new Set([g.provider, r.provider])) {
    if (settings.disclosureAcks[vendorOf(p)] !== DISCLOSURE_VERSION) {
      return { message: `Acknowledge the data disclosure for ${ADAPTERS[p].label} before its first use.`, action: 'DISCLOSURE' };
    }
  }
  if (run.imageAssetIds.length && (!g.imageInput || !r.imageInput)) {
    return { message: 'Images are attached but image input is not enabled for both selected models.', action: 'SETTINGS' };
  }
  const missing = [];
  for (const p of new Set([g.provider, r.provider])) if (!(await getKey(p))) missing.push(ADAPTERS[p].label);
  if (missing.length) return { message: `API key needed for: ${missing.join(', ')}.`, action: 'MISSING_KEYS' };

  const pricingG = settings.pricing[pricingKey(g.provider, g.model)] || null;
  const pricingR = settings.pricing[pricingKey(r.provider, r.model)] || null;
  if (conv.budgetEnforced && (!hasPricing(pricingG) || !hasPricing(pricingR))) {
    return { message: 'Pricing is missing for a selected model.', action: 'PRICING' };
  }

  // Authentication, connectivity and model usability.
  for (const cfg of [g, r]) {
    const models = await ADAPTERS[cfg.provider].listModels(await getKey(cfg.provider));
    const m = models.find((x) => x.id === cfg.model);
    if (!m) return { message: `Model "${cfg.model}" is not available from ${ADAPTERS[cfg.provider].label}.`, action: 'SETTINGS' };
    if (m.maxOutput && cfg.maxOutputTokens > m.maxOutput) {
      return { message: `Max output tokens for ${cfg.model} exceed the model maximum (${m.maxOutput}).`, action: 'SETTINGS' };
    }
  }

  const config = {
    generator: { ...g }, reviewer: { ...r }, iterationLimit: limit, timeouts: { ...settings.timeouts }, pricingG, pricingR,
  };
  await tx(['runs'], 'readwrite', async (s) => {
    const cur = await s.runs.get(run.id);
    await s.runs.put({ ...cur, config });
  });
  return null;
}

// ------------------------------------------------------------------ drive loop

async function drive(runId) {
  if (active.has(runId)) return;
  const controller = new AbortController();
  active.set(runId, controller);
  const release = acquireKeepalive();
  try {
    for (;;) {
      if (controller.signal.aborted) { await finishRun(runId, CR.USER_STOPPED); return; }
      const run = await get('runs', runId);
      if (run.state !== S.RUNNING) return;
      const outcome = await executeStep(run, controller.signal);
      if (outcome.finish) { await finishRun(runId, outcome.finish); return; }
      if (outcome.fail) { await failRun(runId, outcome.fail); return; }
    }
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'aborted') await finishRun(runId, CR.USER_STOPPED);
    else await failRun(runId, { message: e.message || String(e), action: e.action || null });
  } finally {
    active.delete(runId);
    release();
  }
}

async function executeStep(run, signal) {
  switch (run.cursor.kind) {
    case OpKind.G_INITIAL: return stepGenerate(run, signal, false);
    case OpKind.G_REFINE: return stepGenerate(run, signal, true);
    case OpKind.R_REVIEW: return stepReview(run, signal);
    default: throw new Error(`Unknown step ${run.cursor.kind}`);
  }
}

/** Shared view of conversation state needed to build contexts. */
async function loadState(run) {
  return tx(['conversations', 'messages', 'findings', 'runs', 'assets'], 'readonly', async (s) => {
    const conv = await s.conversations.get(run.conversationId);
    const messages = (await s.messages.byIndex('conversationId', run.conversationId)).sort((a, b) => a.seq - b.seq);
    const findings = new Map((await s.findings.byIndex('conversationId', run.conversationId)).map((f) => [f.id, f]));
    const runs = (await s.runs.byIndex('conversationId', run.conversationId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const images = [];
    for (const id of run.imageAssetIds) {
      const a = await s.assets.get(findingKey(run.conversationId, id));
      images.push({ asset_id: id, media_type: a.media_type, base64: bytesToBase64(a.bytes) });
    }
    const byId = new Map(messages.map((m) => [m.id, m]));
    const history = runs
      .filter((r) => r.id !== run.id && r.latestOutputMessageId)
      .map((r) => ({ prompt: r.prompt, output: byId.get(r.latestOutputMessageId)?.text ?? null }));
    return { conv, messages, byId, findings, images, history };
  });
}

const spentUsd = async (conversationId) => {
  const ops = await tx(['operations'], 'readonly', (s) => s.operations.byIndex('conversationId', conversationId));
  return ops.reduce((sum, o) => sum + (o.costUsd || 0), 0);
};

const roleCfg = (run, role) => (role === 'G' ? run.config.generator : run.config.reviewer);
const rolePricing = (run, role) => (role === 'G' ? run.config.pricingG : run.config.pricingR);

async function budgetOk(run, conv, items) {
  return checkReserve({ capUsd: conv.capUsd, spentUsd: await spentUsd(run.conversationId), enforced: conv.budgetEnforced, items });
}

/** G_INITIAL and G_REFINE (§2, §3.8, §3.9, §9.3). */
async function stepGenerate(run, signal, refine) {
  const st = await loadState(run);
  const g = roleCfg(run, 'G');
  const r = roleCfg(run, 'R');
  const refineFindings = refine ? run.lastReportOpenIds.map((id) => st.findings.get(id)) : [];
  const req = buildRequest({
    kind: refine ? OpKind.G_REFINE : OpKind.G_INITIAL,
    prompt: run.prompt, images: st.images, confirmedDecisions: [],
    latestOutput: refine ? st.byId.get(run.latestOutputMessageId)?.text : undefined,
    refineFindings, history: st.history,
    windowTokens: g.contextWindow, maxOutputTokens: g.maxOutputTokens,
  });
  if (req.overflow) return { finish: CR.CONTEXT_LIMIT_EXCEEDED };

  // §9.3 reserve: this G operation + required background ops (none in this build) + the following R review.
  const reviewInputEstimate = req.inputTokens + g.maxOutputTokens + 2000;
  const reserve = await budgetOk(run, st.conv, [
    { pricing: rolePricing(run, 'G'), inputTokens: req.inputTokens, outputTokens: g.maxOutputTokens },
    { pricing: rolePricing(run, 'R'), inputTokens: reviewInputEstimate, outputTokens: r.maxOutputTokens },
  ]);
  if (!reserve.ok) return reserve.reason === 'MISSING_PRICING' ? { fail: { message: 'Pricing is missing.', action: 'PRICING' } } : { finish: CR.BUDGET_REACHED };

  const kind = refine ? OpKind.G_REFINE : OpKind.G_INITIAL;
  const openIds = run.lastReportOpenIds;
  const res = await callWithCorrective(run, st.conv, signal, {
    role: 'G', kind, req,
    validate: (obj) => (refine ? validateRefinement(obj, openIds) : validateInitialG(obj)),
  });
  if (res.finish || res.fail) return res;

  const obj = res.value;
  await tx(['runs', 'messages'], 'readwrite', async (s) => {
    const msg = {
      id: uid('msg'), conversationId: run.conversationId, runId: run.id, seq: nextSeq(), kind: 'g_output',
      text: obj.response, summary: obj.summary, decisions: refine ? obj.decisions : [], assets: [],
      refinementNo: refine ? run.cursor.refinementsDone + 1 : 0, opId: res.opId, createdAt: nowIso(),
    };
    await s.messages.put(msg);
    const cur = await s.runs.get(run.id);
    cur.latestOutputMessageId = msg.id;
    cur.latestOutputReviewed = false;
    cur.cursor = {
      kind: OpKind.R_REVIEW,
      refinementsDone: refine ? cur.cursor.refinementsDone + 1 : 0,
      reviewNo: cur.cursor.reviewNo,
    };
    cur.updatedAt = nowIso();
    await s.runs.put(cur);
  });
  emit({ type: 'run', runId: run.id, conversationId: run.conversationId });
  return {};
}

/** R_REVIEW, including the closing review (§2.1, §3, §7.1). */
async function stepReview(run, signal) {
  const st = await loadState(run);
  const r = roleCfg(run, 'R');
  const currentOpenIds = new Set(run.lastReportOpenIds);
  const all = [...st.findings.values()];
  const req = buildRequest({
    kind: OpKind.R_REVIEW,
    prompt: run.prompt, images: st.images, confirmedDecisions: [],
    latestOutput: st.byId.get(run.latestOutputMessageId)?.text ?? '',
    currentOpen: all.filter((f) => currentOpenIds.has(f.id)),
    resolved: all.filter((f) => f.status === FS.RESOLVED),
    earlierUnresolved: all.filter((f) => !currentOpenIds.has(f.id) && f.status !== FS.RESOLVED),
    history: st.history,
    windowTokens: r.contextWindow, maxOutputTokens: r.maxOutputTokens,
  });
  if (req.overflow) return { finish: CR.CONTEXT_LIMIT_EXCEEDED };

  const affordable = await budgetOk(run, st.conv, [{ pricing: rolePricing(run, 'R'), inputTokens: req.inputTokens, outputTokens: r.maxOutputTokens }]);
  if (!affordable.ok) return affordable.reason === 'MISSING_PRICING' ? { fail: { message: 'Pricing is missing.', action: 'PRICING' } } : { finish: CR.BUDGET_REACHED };

  let applied = null;
  const res = await callWithCorrective(run, st.conv, signal, {
    role: 'R', kind: OpKind.R_REVIEW, req,
    validate: (obj) => {
      const out = applyReviewReport({
        report: obj, findings: st.findings, prevOpenIds: run.lastReportOpenIds,
        cycleId: run.id, nextFindingNumber: st.conv.nextFindingNumber,
      });
      applied = out.result || null;
      return out.errors;
    },
  });
  if (res.finish || res.fail) return res;

  const closing = run.cursor.refinementsDone >= run.config.iterationLimit;
  await tx(['runs', 'messages', 'findings', 'conversations'], 'readwrite', async (s) => {
    for (const f of [...applied.created, ...applied.updated]) {
      await s.findings.put({ ...f, key: findingKey(run.conversationId, f.id), conversationId: run.conversationId });
    }
    const conv = await s.conversations.get(run.conversationId);
    conv.nextFindingNumber = applied.nextFindingNumber;
    await s.conversations.put(conv);
    await s.messages.put({
      id: uid('msg'), conversationId: run.conversationId, runId: run.id, seq: nextSeq(), kind: 'r_report',
      status: res.value.status, summary: res.value.summary, findings: res.value.findings,
      createdIds: applied.created.map((f) => ({ provider_finding_ref: f.providerFindingRef, id: f.id })),
      reviewedMessageId: run.latestOutputMessageId, closing, opId: res.opId, createdAt: nowIso(),
    });
    const cur = await s.runs.get(run.id);
    cur.lastReportOpenIds = applied.openIds;
    cur.latestOutputReviewed = true;
    cur.downgrades = [...cur.downgrades, ...applied.downgrades];
    cur.cursor = { ...cur.cursor, kind: OpKind.G_REFINE, reviewNo: cur.cursor.reviewNo + 1 };
    if (applied.statusMismatch) log(cur, { type: 'R_STATUS_MISMATCH', reported: res.value.status, findingsComplete: applied.complete });
    cur.updatedAt = nowIso();
    await s.runs.put(cur);
  });

  if (applied.complete) return { finish: CR.NO_MATERIAL_ISSUES };
  if (closing) return { finish: CR.MAX_ITERATIONS_REACHED };
  return {};
}

/**
 * One provider operation plus at most one corrective retry (§3.10). Each attempt is its own
 * operation record with usage and cost. Returns {value, opId} | {finish} | {fail}.
 */
async function callWithCorrective(run, conv, signal, { role, kind, req, validate }) {
  const cfg = roleCfg(run, role);
  const pricing = rolePricing(run, role);
  const userMsg = { role: 'user', text: req.text, images: req.images };
  let messages = [userMsg];

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) {
      const ok = await budgetOk(run, conv, [{ pricing, inputTokens: req.inputTokens * 2, outputTokens: cfg.maxOutputTokens }]);
      if (!ok.ok) return { finish: CR.BUDGET_REACHED };
    }
    const { text, opId } = await providerCall(run, signal, { role, kind, cfg, pricing, req, messages, corrective: attempt === 2 });
    const parsed = parseStrictJson(text);
    const errors = parsed.errors.length ? parsed.errors : validate(parsed.value);
    if (!errors.length) {
      await updateOp(opId, { state: OpState.SUCCEEDED, validation: 'VALID' });
      return { value: parsed.value, opId };
    }
    await updateOp(opId, { state: OpState.FAILED, validation: 'INVALID', error: { kind: 'protocol', errors } });
    if (attempt === 2) {
      return { fail: { message: `${role === 'G' ? 'Generator' : 'Reviewer'} returned an invalid response twice: ${errors.slice(0, 3).join(' ')}` } };
    }
    messages = [userMsg, { role: 'assistant', text }, { role: 'user', text: correctiveMessage(errors) }];
  }
  return { fail: { message: 'Unreachable' } };
}

async function updateOp(opId, patch) {
  await tx(['operations'], 'readwrite', async (s) => {
    const op = await s.operations.get(opId);
    await s.operations.put({ ...op, ...patch, endedAt: op.endedAt || nowIso() });
  });
}

/** Persist the operation before and after the call (§5.6), stream with timeouts, record usage. */
async function providerCall(run, signal, { role, kind, cfg, pricing, req, messages, corrective }) {
  const opId = uid('op');
  const apiKey = await getKey(cfg.provider);
  if (!apiKey) throw Object.assign(new Error(`API key for ${ADAPTERS[cfg.provider].label} is no longer available.`), { action: 'MISSING_KEYS' });
  await put('operations', {
    id: opId, conversationId: run.conversationId, runId: run.id, kind, role, corrective,
    purpose: corrective ? `${kind} (corrective retry)` : kind,
    provider: cfg.provider, vendor: vendorOf(cfg.provider), model: cfg.model,
    state: OpState.IN_PROGRESS, createdAt: nowIso(), startedAt: nowIso(), endedAt: null,
    usage: null, costUsd: null, partial: '', error: null,
    // FR-071: the exact context sent, viewable afterwards. Images by asset ID only.
    contextSent: {
      system: req.system,
      messages: messages.map((m) => ({ role: m.role, text: m.text, imageAssetIds: (m.images || []).map((i) => i.asset_id) })),
      compacted: req.compacted, historyIncluded: req.historyIncluded, estimatedInputTokens: req.inputTokens,
    },
  });
  emit({ type: 'run', runId: run.id, conversationId: run.conversationId });

  let lastSave = Date.now();
  let partial = '';
  const adapter = ADAPTERS[cfg.provider];
  const wrapped = {
    ...adapter,
    parseEvent: (evt) => {
      const out = adapter.parseEvent(evt);
      for (const o of out) if (o.type === 'content') partial += o.text;
      return out;
    },
  };
  try {
    const result = await streamCall(wrapped, {
      model: cfg.model, system: req.system, messages, maxOutputTokens: cfg.maxOutputTokens, reasoning: cfg.reasoning,
    }, {
      apiKey, timeouts: run.config.timeouts, signal,
      onActivity: (k) => {
        emit({ type: 'activity', runId: run.id, opId, kind: k }); // drives a generic "Thinking…" indicator
        if (Date.now() - lastSave > 5000) {
          lastSave = Date.now();
          updateOp(opId, { partial, endedAt: null }).catch(() => {});
        }
      },
    });
    const usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
    await tx(['operations'], 'readwrite', async (s) => {
      const op = await s.operations.get(opId);
      // State stays IN_PROGRESS until validation decides SUCCEEDED/FAILED; the result is durably recorded now.
      await s.operations.put({ ...op, partial: result.text, rawResult: result.text, finish: result.finish, usage, costUsd: costUsd(pricing, usage.inputTokens, usage.outputTokens), endedAt: nowIso() });
    });
    return { text: result.text, opId };
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError('network', e.message);
    const usage = err.usage && (err.usage.inputTokens != null || err.usage.outputTokens != null) ? err.usage : null;
    await updateOp(opId, {
      state: OpState.FAILED, partial: err.partial || partial,
      error: { kind: err.kind, message: err.message, status: err.status },
      usage, costUsd: usage ? costUsd(pricing, usage.inputTokens ?? 0, usage.outputTokens ?? 0) : null,
    });
    throw err;
  }
}

// ------------------------------------------------------------------ run endings

function reviewStatusOf(run, findings) {
  if (!run.latestOutputMessageId) return { status: null, labels: [] };
  if (!run.latestOutputReviewed) return { status: ReviewStatus.NOT_REVIEWED, labels: [] };
  const materialOpen = run.lastReportOpenIds.some((id) => findings.get(id)?.material === true);
  const status = materialOpen ? ReviewStatus.LAST_REVIEWED_MATERIAL_REMAIN : ReviewStatus.REVIEWED;
  const stillOpen = new Set(run.lastReportOpenIds);
  const deps = run.downgrades.filter((d) => stillOpen.has(d.finding_id));
  return { status, labels: !materialOpen && deps.length ? [DOWNGRADE_LABEL] : [], downgradeDependencies: deps };
}

async function finishRun(runId, reason) {
  const run = await get('runs', runId);
  if (run.state !== S.RUNNING) return;
  const findings = new Map((await tx(['findings'], 'readonly', (s) => s.findings.byIndex('conversationId', run.conversationId))).map((f) => [f.id, f]));
  const rs = reviewStatusOf(run, findings);
  await transition(runId, S.FINISHED, {
    completionReason: reason, reviewStatus: rs.status, reviewLabels: rs.labels,
    downgradeDependencies: rs.downgradeDependencies || [], finalOutputReviewed: run.latestOutputReviewed,
  });
  await releaseConversation(run.conversationId);
}

async function failRun(runId, { message, action = null }) {
  const run = await get('runs', runId);
  if (run.state !== S.RUNNING) return;
  const findings = new Map((await tx(['findings'], 'readonly', (s) => s.findings.byIndex('conversationId', run.conversationId))).map((f) => [f.id, f]));
  await transition(runId, S.FAILED, { failure: { stage: 'EXECUTION', message }, pendingAction: action, reviewStatus: reviewStatusOf(run, findings).status });
}

async function releaseConversation(conversationId) {
  await tx(['conversations'], 'readwrite', async (s) => {
    const c = await s.conversations.get(conversationId);
    if (c) await s.conversations.put({ ...c, updatedAt: nowIso() });
  });
  emit({ type: 'conversation', conversationId });
}
