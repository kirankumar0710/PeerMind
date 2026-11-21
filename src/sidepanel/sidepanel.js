// Side panel UI (§12). UI only (FR-041): all execution happens in the service worker.
// Untrusted content is only ever rendered with textContent, never as HTML.
import { loadConversation } from '../storage/db.js';
import { buildExportZip } from '../export/export.js';
import { summarizeUsage, hasPricing } from '../core/budget.js';
import { defaultPricing } from '../providers/pricing.js';
import {
  RunState as S, CompletionReason as CR, DISCLOSURE_TEXT, DISCLOSURE_VERSION, ITERATION_LIMIT, ReviewStatus, OpState,
} from '../core/constants.js';
import { bytesToBase64, MEDIA_EXT } from '../core/util.js';

const ui = {
  tab: 'run', app: null, convId: null, data: null, attachments: [], promptDraft: '', newTools: {},
  error: null, thinkingOp: null, settingsDraft: null, settingsNotice: null, saveStatus: null, models: {}, modelErrors: {}, modelsLoading: new Set(), providerMsg: {},
};

// ------------------------------------------------------------------ helpers
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error || 'No response from PeerMind service worker.');
  return res.result;
}

async function act(fn) {
  ui.error = null;
  try { await fn(); } catch (e) { ui.error = e.message; }
  await refresh();
}

const money = (v) => (v == null ? 'Not available' : `$${v.toFixed(v < 0.01 ? 4 : 2)} (est.)`);
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');
const providerLabel = (id) => ui.app?.providers.find((p) => p.id === id)?.label || id;

function confirmDialog(title, body, okLabel = 'Confirm') {
  const dlg = document.getElementById('dialog');
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(false); // Esc counts as Cancel; a prior resolve(true) wins
    dlg.replaceChildren(
      h('h2', {}, title),
      ...(Array.isArray(body) ? body : [h('p', {}, body)]),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' },
        h('button', { onclick: () => { dlg.close(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'primary', onclick: () => { dlg.close(); resolve(true); } }, okLabel)),
    );
    dlg.showModal();
  });
}

async function ensureDisclosures(providerIds) {
  for (const p of new Set(providerIds)) {
    const vendor = ui.app.providers.find((x) => x.id === p)?.vendor;
    if (ui.app.settings.disclosureAcks[vendor] === DISCLOSURE_VERSION) continue;
    const ok = await confirmDialog(`Before using ${providerLabel(p)}`, DISCLOSURE_TEXT, 'I understand');
    if (!ok) return false;
    ui.app.settings = await send('ackDisclosure', { provider: p });
  }
  return true;
}

// ------------------------------------------------------------------ data
async function refresh({ background = false } = {}) {
  try {
    ui.app = await send('getState');
    if (ui.app.focusConversation) { ui.convId = ui.app.focusConversation; ui.tab = 'run'; }
    if (ui.convId && !ui.app.conversations.some((c) => c.id === ui.convId)) ui.convId = null;
    ui.data = ui.convId ? await loadConversation(ui.convId) : null;
  } catch (e) {
    ui.error = e.message;
  }
  // Background updates never re-render Settings, so unsaved edits there are not lost.
  if (background && ui.tab === 'settings') return;
  render();
}

let refreshTimer = null;
const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh({ background: true }), 150); };

// Live connection to the service worker. If the browser stops the worker the port disconnects;
// reconnecting wakes it, and on start-up it marks a run that lost its worker INTERRUPTED (§5.6).
const activity = { opId: null, kind: null, at: 0 }; // last stream activity, for the live status line
function connectPort() {
  const port = chrome.runtime.connect({ name: 'panel' });
  port.onMessage.addListener((evt) => {
    if (evt.type === 'activity') {
      Object.assign(activity, { opId: evt.opId, kind: evt.kind, at: Date.now() });
      ui.thinkingOp = evt.opId;
      return;
    }
    scheduleRefresh();
  });
  port.onDisconnect.addListener(() => setTimeout(() => { connectPort(); scheduleRefresh(); }, 1000));
}
connectPort();

// While a run is executing, poll as a safety net (a missed event must never freeze the panel)
// and tick the live status line every second.
setInterval(() => {
  const run = ui.data?.runs.at(-1);
  if (run && (run.state === S.RUNNING || run.state === S.PREFLIGHT)) refresh({ background: true });
}, 5000);
setInterval(() => {
  const el = document.getElementById('live-status');
  if (el) el.textContent = liveStatusText();
}, 1000);

/** "Waiting for first output · 1m 05s elapsed · thinking 2s ago" for the in-flight operation. */
function liveStatusText() {
  const op = ui.data?.operations.filter((o) => o.state === OpState.IN_PROGRESS).at(-1);
  if (!op) return '';
  const secs = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  };
  const elapsed = Date.now() - new Date(op.startedAt).getTime();
  const phase = op.partial ? 'Receiving output' : 'Waiting for first output';
  const last = activity.opId === op.id && activity.at
    ? `last ${activity.kind === 'reasoning' ? 'thinking signal' : 'output'} ${secs(Date.now() - activity.at)} ago`
    : 'no stream activity yet';
  return `${phase} from ${providerLabel(op.provider)} ${op.model} · ${secs(elapsed)} elapsed · ${last}`;
}

// ------------------------------------------------------------------ render
function render() {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab));
  for (const t of ['run', 'history', 'settings']) document.getElementById(`tab-${t}`).hidden = t !== ui.tab;
  renderBanners();
  if (ui.tab === 'run') renderRun();
  if (ui.tab === 'history') renderHistory();
  if (ui.tab === 'settings') renderSettings();
}

function renderBanners() {
  const el = document.getElementById('banners');
  const items = [];
  if (ui.error) items.push(h('div', { class: 'banner bad' }, ui.error));
  const conv = ui.data?.conversation;
  if (conv && !conv.budgetEnforced) items.push(h('div', { class: 'banner warn' }, 'BUDGET CAP NOT ENFORCED'));
  const latest = ui.data?.runs.at(-1);
  if (latest?.waitingForLock && ui.app.globalLockRunId !== latest.id) {
    items.push(h('div', { class: 'banner info' }, 'Waiting for the active run in another conversation to finish.'));
  }
  el.replaceChildren(...items);
}

function configSummary() {
  const s = ui.app.settings;
  const sameVendor = ui.app.providers.find((p) => p.id === s.generator.provider)?.vendor ===
    ui.app.providers.find((p) => p.id === s.reviewer.provider)?.vendor;
  const roleLine = (cls, name, cfg) => h('div', {},
    h('span', { class: cls }, name), ' ', providerLabel(cfg.provider), ' · ', cfg.model || h('em', {}, 'no model'),
    ' ', ui.app.keys[cfg.provider] ? h('span', { class: 'pill ok' }, 'key set') : h('span', { class: 'pill bad' }, 'no key'));
  const usage = ui.data ? summarizeUsage(ui.data.operations).total : null;
  return h('section', { class: 'card' },
    roleLine('role-g', 'Generator', s.generator),
    roleLine('role-r', 'Reviewer', s.reviewer),
    sameVendor ? h('div', { class: 'error small' }, 'Generator and Reviewer must be different vendors.') : null,
    h('div', { class: 'small muted' },
      `Iteration limit ${s.iterationLimit} · max output: Generator ${s.generator.maxOutputTokens} / Reviewer ${s.reviewer.maxOutputTokens} tokens`),
    ui.data ? h('div', { class: 'small muted' },
      `Spend ${money(usage.costUsd)}${usage.costIncomplete ? ' (some costs not available)' : ''} of cap $${ui.data.conversation.capUsd} · estimates may differ slightly from actual charges and a small overshoot of the cap is possible`) : null,
  );
}

function reviewPill(run) {
  if (!run?.reviewStatus) return null;
  const cls = run.reviewStatus === ReviewStatus.REVIEWED ? 'ok' : run.reviewStatus === ReviewStatus.NOT_REVIEWED ? 'bad' : 'warn';
  return [h('span', { class: `pill ${cls}` }, run.reviewStatus), ...(run.reviewLabels || []).map((l) => h('span', { class: 'pill warn' }, l))];
}

function renderRun() {
  const root = document.getElementById('tab-run');
  // Keep typing undisturbed: remember focus and caret in the prompt box across re-renders.
  const active = document.activeElement;
  const caret = active?.id === 'prompt-input' ? [active.selectionStart, active.selectionEnd] : null;

  // Order: configuration, then the prompt box, then the run and its results.
  const parts = [configSummary(), promptCard()];
  const d = ui.data;
  if (d) {
    const run = d.runs.at(-1);
    parts.push(runStatusCard(run));
    const outMsg = [...d.runs].reverse().map((r) => d.messages.find((m) => m.id === r.latestOutputMessageId)).find(Boolean);
    if (outMsg) {
      const outRun = d.runs.find((r) => r.id === outMsg.runId);
      parts.push(h('section', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Latest output'),
          h('button', { onclick: () => navigator.clipboard.writeText(outMsg.text) }, 'Copy Final Output')),
        h('div', { class: 'small muted', style: 'margin-bottom:6px' }, `For prompt: ${outRun.prompt || '(image only)'}`),
        h('div', { class: 'row', style: 'margin-bottom:6px' }, outRun.state === S.FINISHED || outRun.reviewStatus ? reviewPill(outRun)
          : h('span', { class: `pill ${outRun.latestOutputReviewed ? 'info' : 'warn'}` }, outRun.latestOutputReviewed ? 'reviewed, run in progress' : 'awaiting review')),
        h('div', { class: 'output' }, outMsg.text || '(empty response)'),
        sourcesList(outMsg.sources),
        (outRun.downgradeDependencies || []).length ? h('div', { class: 'small' }, h('h3', {}, 'Severity downgrades this completion depends on'),
          ...outRun.downgradeDependencies.map((dg) => h('div', {}, `${dg.finding_id}: ${dg.from} → ${dg.to} — ${dg.reason}`))) : null));
    }
    parts.push(findingsCard(d, run), iterationsCard(d), timelineCard(d));
  }
  root.replaceChildren(...parts.filter(Boolean));
  if (caret) {
    const ta = document.getElementById('prompt-input');
    ta?.focus();
    ta?.setSelectionRange(caret[0], caret[1]);
  }
}

function runStatusCard(run) {
  if (!run) return null;
  const actions = [];
  const st = run.state;
  const explain = [];
  if (st === S.CREATED) {
    explain.push(run.waitingForLock ? 'Waiting for the active run to finish.' : 'Created.');
    actions.push(h('button', { onclick: () => act(() => send('stop', { runId: run.id })) }, 'Abandon'));
  }
  if (st === S.PREFLIGHT || st === S.RUNNING) {
    const step = {
      G_INITIAL: 'Generator is writing the initial response',
      R_REVIEW: 'Reviewer is reviewing the response',
      G_REFINE: 'Generator is refining the response',
    }[run.cursor.kind] || 'Working';
    explain.push(h('span', { class: 'thinking' }, st === S.PREFLIGHT ? 'Checking providers' : `${step} (refinements ${run.cursor.refinementsDone}/${run.config?.iterationLimit ?? '?'})`));
    if (st === S.RUNNING) explain.push(h('span', { id: 'live-status', class: 'muted' }, liveStatusText()));
    actions.push(h('button', { class: 'danger', onclick: () => act(() => send('stop', { runId: run.id })) }, 'Stop'));
  }
  if (st === S.FAILED || st === S.PAUSED_WAITING_FOR_USER) {
    explain.push(h('span', { class: 'error' }, run.failure?.message || 'Needs your action.'));
    if (run.pendingAction === 'PRICING') {
      explain.push('Pricing is missing for a selected model. Choose one:');
      actions.push(
        h('button', { onclick: () => { ui.tab = 'settings'; render(); } }, 'Enter pricing, then Retry'),
        h('button', { onclick: () => act(async () => {
          if (!(await confirmDialog('Proceed without a budget cap?', 'Usage will still be recorded where available, but this conversation will not be stopped by its USD cap.', 'Proceed unenforced'))) return;
          await send('disableBudgetEnforcement', { conversationId: run.conversationId });
          await send('retry', { runId: run.id });
        }) }, 'Proceed with cap disabled'),
      );
    } else if (run.pendingAction === 'MISSING_KEYS' || run.pendingAction === 'SETTINGS') {
      actions.push(h('button', { onclick: () => { ui.tab = 'settings'; render(); } }, 'Open settings'));
    }
    actions.push(
      h('button', { class: 'primary', onclick: () => act(async () => {
        const s = ui.app.settings;
        if (await ensureDisclosures([s.generator.provider, s.reviewer.provider])) await send('retry', { runId: run.id });
      }) }, 'Retry'),
      h('button', { class: 'danger', onclick: () => act(() => send('abandon', { runId: run.id })) }, run.pendingAction === 'PRICING' ? 'Cancel' : 'Abandon'),
    );
  }
  if (st === S.INTERRUPTED) {
    explain.push('This run was interrupted. Resume re-checks providers and keys before any call.');
    actions.push(
      h('button', { class: 'primary', onclick: () => act(async () => {
        let r = await send('resume', { runId: run.id });
        if (r?.needsApproval) {
          const ok = await confirmDialog('Retry an operation with unknown outcome?',
            'An operation may have completed at the provider before PeerMind was interrupted. Retrying it may duplicate processing and charges.', 'Retry anyway');
          if (ok) r = await send('resume', { runId: run.id, approveUnknown: true });
        }
      }) }, 'Resume'),
      h('button', { class: 'danger', onclick: () => act(() => send('abandon', { runId: run.id })) }, 'Abandon'),
    );
  }
  if (st === S.FINISHED) {
    explain.push(`Finished: ${run.completionReason}`);
    if (run.completionReason === CR.BUDGET_REACHED) {
      const cap = h('input', { type: 'number', min: '0', step: '0.5', value: String(ui.data.conversation.capUsd * 2), style: 'width:90px' });
      actions.push(cap,
        h('button', { onclick: () => act(() => send('updateConversation', { conversationId: run.conversationId, patch: { capUsd: Number(cap.value), readOnly: false } })) }, 'Raise cap'),
        h('button', { onclick: () => act(() => send('updateConversation', { conversationId: run.conversationId, patch: { readOnly: true } })) }, 'Keep read-only'),
        h('button', { onclick: () => { ui.convId = null; ui.data = null; render(); } }, 'New conversation'));
    }
    if (run.completionReason === CR.CONTEXT_LIMIT_EXCEEDED) {
      explain.push('Required context does not fit the model window. Shorten the prompt, remove attachments, choose a model with a larger window, or start a new conversation.');
    }
  }
  if (st === S.ABANDONED) explain.push(`Abandoned: ${run.abandonmentReason}`);
  return h('section', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Run'), h('span', { class: 'pill info' }, st)),
    ...explain.map((e) => h('div', { class: 'small' }, e)),
    actions.length ? h('div', { class: 'row', style: 'margin-top:8px' }, actions) : null);
}

function findingsCard(d, run) {
  if (!d.findings.length) return null;
  const current = new Set(run?.lastReportOpenIds || []);
  const rows = d.findings.map((f) => h('tr', {},
    h('td', {}, f.id), h('td', {}, f.severity), h('td', {}, f.category), h('td', {}, f.material ? 'yes' : 'no'),
    h('td', {}, h('span', { class: `pill ${f.status === 'RESOLVED' ? 'ok' : f.material ? 'bad' : 'warn'}` }, f.status),
      current.has(f.id) ? '' : f.status !== 'RESOLVED' ? h('div', { class: 'muted small' }, 'earlier cycle') : ''),
    h('td', {}, f.description, h('div', { class: 'muted' }, f.suggestion))));
  return h('section', { class: 'card' }, h('h2', {}, 'Findings'),
    h('table', {}, h('thead', {}, h('tr', {}, ...['ID', 'Severity', 'Category', 'Material', 'Status', 'Issue'].map((t) => h('th', {}, t)))), h('tbody', {}, rows)));
}

// Plain-language labels for the UI; internal codes (G_INITIAL, R_REVIEW, …) are never shown.
const ROLE_LABEL = { G: 'Generator', R: 'Reviewer' };
const OP_LABEL = { G_INITIAL: 'Initial response', R_REVIEW: 'Review', G_REFINE: 'Refine message' };
const REVIEW_STATUS_LABEL = { ISSUES_FOUND: 'Issues found', NO_MATERIAL_ISSUES: 'No material issues' };
const DECISION_LABEL = { APPLIED: 'Applied', REJECTED: 'Rejected', ALREADY_ADDRESSED: 'Already addressed', NO_CHANGE_NEEDED: 'No change needed' };
const opLabel = (o) => `${OP_LABEL[o.kind] || o.kind}${o.corrective ? ' (format retry)' : ''}`;

function iterationsCard(d) {
  const items = d.messages.map((m) => {
    if (m.kind === 'user') return h('details', {}, h('summary', {}, `User message · ${time(m.createdAt)}`), h('div', { class: 'output' }, m.text || '(image only)'), m.assetIds?.length ? h('div', { class: 'small muted' }, m.assetIds.join(', ')) : null);
    if (m.kind === 'g_output') {
      return h('details', {}, h('summary', {}, h('span', { class: 'role-g' }, m.refinementNo ? `Refine message ${m.refinementNo}` : 'Initial response'), ` · ${m.summary}`),
        m.decisions?.length ? h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Finding'), h('th', {}, 'Decision'), h('th', {}, 'Reason'))),
          h('tbody', {}, m.decisions.map((x) => h('tr', {}, h('td', {}, x.finding_id), h('td', {}, DECISION_LABEL[x.decision] || x.decision), h('td', {}, x.reason))))) : null,
        h('div', { class: 'output' }, m.text),
        sourcesList(m.sources));
    }
    if (m.kind === 'r_report') {
      return h('details', {}, h('summary', {}, h('span', { class: 'role-r' }, m.closing ? 'Closing review' : 'Review'), ` · ${REVIEW_STATUS_LABEL[m.status] || m.status} · ${m.summary}`),
        sourcesList(m.sources, 'Sources the Reviewer checked'),
        h('pre', {}, JSON.stringify(m.findings, null, 2)));
    }
    return null;
  });
  return h('section', { class: 'card' }, h('h2', {}, 'Iteration history'), items);
}

function timelineCard(d) {
  const usage = summarizeUsage(d.operations);
  const rows = d.operations.map((o) => h('details', {},
    h('summary', {}, h('span', { class: o.role === 'G' ? 'role-g' : 'role-r' }, opLabel(o)), ` · ${providerLabel(o.provider)} ${o.model} · ${time(o.startedAt)} · `,
      h('span', { class: `pill ${o.state === OpState.SUCCEEDED ? 'ok' : o.state === OpState.IN_PROGRESS ? 'info' : 'bad'}` }, o.state),
      o.state === OpState.IN_PROGRESS && ui.thinkingOp === o.id ? h('span', { class: 'thinking small' }, ' Thinking') : null),
    h('div', { class: 'small' }, `Sent to: ${providerLabel(o.provider)} · tokens in ${o.usage?.inputTokens ?? 'n/a'} / out ${o.usage?.outputTokens ?? 'n/a'}${o.usage?.webSearches ? ` · ${o.usage.webSearches} web search${o.usage.webSearches === 1 ? '' : 'es'}` : ''} · cost ${money(o.costUsd)}`),
    o.error ? h('div', { class: 'small error' }, o.error.message || (o.error.errors || []).join(' ')) : null,
    h('details', {}, h('summary', { class: 'small' }, 'Context sent'), h('pre', {}, JSON.stringify(o.contextSent, null, 2))),
    o.partial && o.state !== OpState.SUCCEEDED ? h('details', {}, h('summary', { class: 'small' }, 'Partial output'), h('pre', {}, o.partial)) : null));
  return h('section', { class: 'card' }, h('h2', {}, 'Timeline'), rows,
    h('h3', {}, 'Usage by role'),
    ...usage.byRole.map((r) => h('div', { class: 'small' }, `${ROLE_LABEL[r.role] || r.role} · ${providerLabel(r.provider)}: ${r.inputTokens} in / ${r.outputTokens} out · ${r.costIncomplete && !r.costUsd ? 'Not available' : money(r.costUsd)}`)));
}

/** Clickable source links (http/https only), opened in a new tab. */
function sourcesList(sources, title = 'Sources') {
  const safe = (sources || []).filter((x) => /^https?:\/\//i.test(x.url));
  if (!safe.length) return null;
  return h('details', { class: 'sources', open: title === 'Sources' },
    h('summary', { class: 'small' }, `🔗 ${title} (${safe.length})`),
    h('ol', { class: 'small' }, safe.map((x) => h('li', {},
      h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.title || x.url),
      h('span', { class: 'muted' }, ` · ${new URL(x.url).hostname}`)))));
}

/**
 * One switch per built-in tool in tools.json (e.g. "Web search"). For a new conversation it sets the
 * starting value; for an existing one it updates the conversation and applies from the next run or
 * retry. Switches only allow a tool; the model decides when to use it.
 */
function toolToggles(d) {
  return (ui.app.tools || []).map((tool) => {
    const stored = d ? d.conversation.tools?.[tool.id] ?? (tool.id === 'web_search' ? d.conversation.webSearch : undefined) : ui.newTools[tool.id];
    const on = typeof stored === 'boolean' ? stored : tool.defaultEnabled;
    return h('label', { style: 'margin:0', title: tool.description },
      h('input', {
        type: 'checkbox', checked: on,
        onchange: (e) => {
          if (d) act(() => send('updateConversation', { conversationId: d.conversation.id, patch: { tools: { [tool.id]: e.target.checked } } }));
          else ui.newTools = { ...ui.newTools, [tool.id]: e.target.checked };
        },
      }),
      ` ${tool.label}`);
  });
}

function promptCard() {
  const d = ui.data;
  const unfinished = d?.runs.some((r) => r.state !== S.FINISHED && r.state !== S.ABANDONED);
  const readOnly = d?.conversation.readOnly;
  const s = ui.app.settings;
  const sameVendor = ui.app.providers.find((p) => p.id === s.generator.provider)?.vendor === ui.app.providers.find((p) => p.id === s.reviewer.provider)?.vendor;
  const notReady = !s.generator.model || !s.reviewer.model || sameVendor || !ui.app.keys[s.generator.provider] || !ui.app.keys[s.reviewer.provider];
  const blocked = unfinished || readOnly || notReady;

  const ta = h('textarea', { id: 'prompt-input', placeholder: d ? 'Next prompt in this conversation…' : 'What should the two models work on?', oninput: (e) => { ui.promptDraft = e.target.value; } });
  ta.value = ui.promptDraft;
  const cap = d ? null : h('input', { type: 'number', min: '0', step: '0.5', value: String(s.defaultCapUsd), style: 'width:90px' });
  const file = h('input', {
    type: 'file', accept: Object.keys(MEDIA_EXT).join(','), multiple: true,
    onchange: async (e) => {
      for (const f of e.target.files) {
        if (!MEDIA_EXT[f.type]) continue;
        ui.attachments.push({ media_type: f.type, base64: bytesToBase64(await f.arrayBuffer()), url: URL.createObjectURL(f) });
      }
      render();
    },
  });
  return h('section', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, d ? 'Next prompt' : 'New prompt'),
      d ? h('button', { onclick: () => { ui.convId = null; ui.data = null; render(); } }, 'New conversation') : null),
    // The conversation keeps the name of its first prompt; it labels the thread, not this prompt.
    d ? h('div', { class: 'small muted', style: 'margin-bottom:6px' }, `In conversation: ${d.conversation.title}`) : null,
    ta,
    h('div', { class: 'thumbs' }, ui.attachments.map((a, i) => h('img', { src: a.url, title: 'Click to remove', onclick: () => { ui.attachments.splice(i, 1); render(); } }))),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('label', { style: 'margin:0' }, 'Images ', file),
      ...toolToggles(d),
      cap ? h('span', { class: 'small muted' }, 'Cap USD ', cap) : null,
      h('span', { class: 'grow' }),
      h('button', {
        class: 'primary', disabled: blocked,
        onclick: () => act(async () => {
          if (!(await ensureDisclosures([s.generator.provider, s.reviewer.provider]))) return;
          const res = await send('submitPrompt', {
            conversationId: ui.convId, prompt: ui.promptDraft,
            images: ui.attachments.map(({ media_type, base64 }) => ({ media_type, base64 })),
            capUsd: cap ? Number(cap.value) : undefined,
            tools: ui.newTools,
          });
          ui.convId = res.conversationId;
          ui.promptDraft = '';
          ui.attachments = [];
        }),
      }, 'Start')),
    blocked ? h('div', { class: 'small muted' }, unfinished ? 'Finish or abandon the current run first.' : readOnly ? 'This conversation is read-only.' : 'Configure both providers, models and keys in Settings (different vendors).') : null,
    h('div', { class: 'small muted' }, 'Provider API usage is billed by each provider, separately from consumer subscriptions.'));
}

// ------------------------------------------------------------------ history tab
function renderHistory() {
  const root = document.getElementById('tab-history');
  root.replaceChildren(h('section', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Conversations'),
      h('button', { class: 'danger', onclick: () => act(async () => {
        if (await confirmDialog('Clear all history?', 'This deletes every conversation, run, finding and image stored by PeerMind in this browser.', 'Delete everything')) {
          await send('clearHistory');
          ui.convId = null;
        }
      }) }, 'Clear history')),
    ui.app.conversations.length ? null : h('div', { class: 'muted' }, 'No conversations yet.'),
    ...ui.app.conversations.map((c) => h('div', { class: 'list-item' },
      h('div', { class: 'grow' }, h('div', {}, c.title), h('div', { class: 'small muted' }, new Date(c.updatedAt).toLocaleString(), c.unfinishedState ? ` · ${c.unfinishedState}` : '')),
      h('button', { onclick: () => { ui.convId = c.id; ui.tab = 'run'; refresh(); } }, 'Open'),
      h('button', { onclick: () => act(() => exportConversation(c.id)) }, 'Export'),
      h('button', { class: 'danger', onclick: () => act(async () => {
        if (await confirmDialog('Delete conversation?', `“${c.title}” and its images will be removed.`, 'Delete')) {
          await send('deleteConversation', { conversationId: c.id });
          if (ui.convId === c.id) ui.convId = null;
        }
      }) }, 'Delete')))));
}

async function exportConversation(id) {
  const data = await loadConversation(id);
  const zip = buildExportZip(data);
  const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
  const a = h('a', { href: url, download: `peermind-${id}.zip` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ------------------------------------------------------------------ settings tab
/** List the models the stored key can access, each classified as supported or not. */
async function loadModels(provider) {
  try {
    const models = await send('listModels', { provider });
    ui.models[provider] = models;
    delete ui.modelErrors[provider];
    ui.providerMsg[provider] = `Connected · ${models.filter((m) => m.supported).length} of ${models.length} models supported`;
  } catch (e) {
    delete ui.models[provider];
    ui.modelErrors[provider] = e.message;
    ui.providerMsg[provider] = `Test failed: ${e.message}`;
  }
}

/**
 * Read-only capability information for the selected model, detected from the model ID.
 * The only choice offered is Claude extended thinking, which changes cost and output.
 */
function capabilityInfo(cfg, model) {
  if (!model?.capabilities) return null;
  const c = model.capabilities;
  const reasoningText = !c.reasoning ? 'Not a reasoning model'
    : c.thinkingIsOptional ? (cfg.extendedThinking ? 'Extended thinking on' : 'Supports extended thinking (off)')
    : c.thinkingMode === 'always' ? 'Thinking is always on for this model (thinking tokens are billed as output)'
    : 'Reasoning model: progress signals requested automatically';
  return h('div', { class: 'small', style: 'margin-top:6px' },
    h('div', {}, `${c.reasoning ? '🟢' : '⚪'} Reasoning: ${reasoningText}`),
    h('div', {}, `${c.imageInput ? '🟢' : '⚪'} Image input: ${c.imageInput ? 'Supported' : 'Not supported (prompts with images will be blocked)'}`),
    ...(ui.app.tools || []).map((t) => {
      const ok = (c.tools || []).includes(t.id);
      return h('div', {}, `${ok ? '🟢' : '⚪'} ${t.label}: ${ok ? 'Supported (used when the conversation allows it)' : 'Not supported for this model'}`);
    }),
    c.reasoning && c.thinkingIsOptional ? h('label', {},
      h('input', { type: 'checkbox', checked: !!cfg.extendedThinking, onchange: (e) => { cfg.extendedThinking = e.target.checked; render(); } }),
      ' Use extended thinking: better on hard tasks, but slower and costs more (thinking tokens are billed)') : null,
    h('div', { class: 'muted' }, 'Detected from the model name. Reasoning content is never shown or stored.'));
}

const vendorOfProvider = (id) => ui.app.providers.find((p) => p.id === id)?.vendor;

/**
 * FR-004: G and R must be different vendors. When the Generator moves onto the Reviewer's vendor,
 * switch the Reviewer to the first provider from another vendor and clear its model.
 */
function ensureDifferentReviewer(s) {
  ui.settingsNotice = null;
  const gVendor = vendorOfProvider(s.generator.provider);
  if (vendorOfProvider(s.reviewer.provider) !== gVendor) return;
  const next = ui.app.providers.find((p) => p.vendor !== gVendor);
  if (!next) return;
  const from = ui.app.providers.find((p) => p.id === s.reviewer.provider)?.label;
  s.reviewer.provider = next.id;
  s.reviewer.model = '';
  ui.settingsNotice = `Reviewer switched from ${from} to ${next.label}, because the Generator now uses ${from}. Choose a Reviewer model.`;
}

function renderSettings() {
  const root = document.getElementById('tab-settings');
  // Edits live in a draft until "Save settings", so re-renders never lose them.
  const s = (ui.settingsDraft ||= structuredClone(ui.app.settings));
  s.disclosureAcks = { ...ui.app.settings.disclosureAcks };
  const providers = ui.app.providers;
  if (vendorOfProvider(s.generator.provider) === vendorOfProvider(s.reviewer.provider)) ensureDifferentReviewer(s);

  // Load model lists automatically for the selected providers once a key exists.
  for (const p of new Set([s.generator.provider, s.reviewer.provider])) {
    if (ui.app.keys[p] && !ui.models[p] && !ui.modelErrors[p] && !ui.modelsLoading.has(p)) {
      ui.modelsLoading.add(p);
      loadModels(p).finally(() => { ui.modelsLoading.delete(p); if (ui.tab === 'settings') render(); });
    }
  }

  const keyRows = providers.map((p) => {
    const input = h('input', { type: 'password', placeholder: ui.app.keys[p.id] ? `Saved: ${ui.app.keys[p.id]}` : 'API key', autocomplete: 'off' });
    return h('div', { class: 'list-item' },
      h('div', { style: 'width:110px' }, p.label),
      h('div', { class: 'grow' }, input, ui.providerMsg[p.id] ? h('div', { class: 'small muted' }, ui.providerMsg[p.id]) : null),
      h('button', { onclick: () => act(async () => { await send('setKey', { provider: p.id, key: input.value }); }) }, 'Save'),
      h('button', { disabled: !ui.app.keys[p.id], onclick: () => act(() => loadModels(p.id)) }, 'Test'),
      h('button', { class: 'danger', disabled: !ui.app.keys[p.id], onclick: () => act(() => send('removeKey', { provider: p.id })) }, 'Remove'));
  });

  const roleSection = (key, title, cls) => {
    const cfg = s[key];
    const models = ui.models[cfg.provider];
    const hasKey = !!ui.app.keys[cfg.provider];
    const reload = () => act(() => loadModels(cfg.provider));

    // 🟢 supported with this key · 🔴 listed for this key but not usable by PeerMind (disabled).
    const options = [];
    if (!cfg.model) options.push(h('option', { value: '', selected: true, disabled: true }, models ? 'Select a model…' : 'Load models to choose'));
    if (cfg.model && !models?.some((m) => m.id === cfg.model)) {
      options.push(h('option', { value: cfg.model, selected: true },
        models ? `🔴 ${cfg.model}: not available with this key` : `⚪ ${cfg.model}: not checked yet`));
    }
    for (const m of models || []) {
      const name = m.label && m.label !== m.id ? `${m.id} (${m.label})` : m.id;
      options.push(h('option', { value: m.id, selected: m.id === cfg.model, disabled: !m.supported, title: m.reason || '' },
        m.supported ? `🟢 ${name}` : `🔴 ${name}: ${m.reason}`));
    }
    const current = models?.find((m) => m.id === cfg.model);
    const status = !hasKey ? h('div', { class: 'small error' }, 'Add an API key for this provider first.')
      : ui.modelErrors[cfg.provider] ? h('div', { class: 'small error' }, `Could not load models: ${ui.modelErrors[cfg.provider]}`)
      : !models ? h('div', { class: 'small muted' }, 'Loading models…')
      : !cfg.model ? h('div', { class: 'small muted' }, `${models.filter((m) => m.supported).length} of ${models.length} models usable with this key`)
      : current?.supported ? h('div', { class: 'small', style: 'color:var(--ok)' }, '🟢 Supported and available with this key')
      : h('div', { class: 'small error' }, `🔴 ${current ? current.reason : 'Not available with this key'}`);

    return h('div', {},
      h('h3', {}, h('span', { class: cls }, title)),
      h('label', {}, 'Provider'),
      h('select', { onchange: (e) => {
        cfg.provider = e.target.value;
        cfg.model = '';
        if (key === 'generator') ensureDifferentReviewer(s);
        render();
      } },
      providers.map((p) => {
        // FR-004: the Reviewer can never use the Generator's vendor, so that option is disabled.
        const takenByGenerator = key === 'reviewer' && p.vendor === vendorOfProvider(s.generator.provider);
        return h('option', { value: p.id, selected: p.id === cfg.provider, disabled: takenByGenerator },
          `${p.label} (vendor: ${p.vendor})${takenByGenerator ? ': used by Generator' : ''}`);
      })),
      key === 'reviewer' && ui.settingsNotice ? h('div', { class: 'small', style: 'color:var(--warn)' }, ui.settingsNotice) : null,
      h('label', {}, 'Model'),
      h('div', { class: 'row' },
        h('select', { class: 'grow', disabled: !hasKey, onchange: (e) => {
          cfg.model = e.target.value;
          const m = models?.find((x) => x.id === cfg.model);
          if (m?.contextWindow) cfg.contextWindow = m.contextWindow;
          if (m?.maxOutput && cfg.maxOutputTokens > m.maxOutput) cfg.maxOutputTokens = m.maxOutput;
          render();
        } }, options),
        h('button', { disabled: !hasKey, onclick: reload }, 'Refresh')),
      status,
      h('div', { class: 'small muted' }, '🟢 supported · 🔴 not supported (cannot be selected)'),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', {}, 'Max output tokens'), h('input', { type: 'number', min: '256', value: cfg.maxOutputTokens, oninput: (e) => { cfg.maxOutputTokens = parseInt(e.target.value, 10); } })),
        h('div', { class: 'grow' }, h('label', {}, 'Context window (tokens)'), h('input', { type: 'number', min: '1024', value: cfg.contextWindow, oninput: (e) => { cfg.contextWindow = parseInt(e.target.value, 10); } }))),
      capabilityInfo(cfg, current),
      pricingInputs(s, cfg));
  };

  const t = s.timeouts;
  const sec = (field) => h('input', { type: 'number', min: '1', value: Math.round(t[field] / 1000), oninput: (e) => { t[field] = Number(e.target.value) * 1000; } });

  root.replaceChildren(
    h('section', { class: 'card' }, h('h2', {}, 'Provider API keys'),
      h('div', { class: 'small muted' }, 'Keys are masked and held for this browser session only; they are cleared when the browser closes and never appear in prompts, logs or exports.'),
      keyRows),
    h('section', { class: 'card' }, h('h2', {}, 'Roles'),
      roleSection('generator', 'Generator', 'role-g'),
      roleSection('reviewer', 'Reviewer', 'role-r')),
    h('section', { class: 'card' }, h('h2', {}, 'Run settings'),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', {}, `Iteration limit (${ITERATION_LIMIT.min}–${ITERATION_LIMIT.max}; closing review not counted)`),
          h('input', { type: 'number', min: String(ITERATION_LIMIT.min), max: String(ITERATION_LIMIT.max), value: s.iterationLimit, oninput: (e) => { s.iterationLimit = parseInt(e.target.value, 10); } })),
        h('div', { class: 'grow' }, h('label', {}, 'Default conversation cap (USD)'),
          h('input', { type: 'number', min: '0', step: '0.5', value: s.defaultCapUsd, oninput: (e) => { s.defaultCapUsd = Number(e.target.value); } }))),
      h('h3', {}, 'Timeouts (seconds)'),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', {}, 'Streaming headers'), sec('streamingHeadersMs')),
        h('div', { class: 'grow' }, h('label', {}, 'First content'), sec('firstContentMs')),
        h('div', { class: 'grow' }, h('label', {}, 'Inactivity'), sec('inactivityMs')),
        h('div', { class: 'grow' }, h('label', {}, 'Non-streaming'), sec('nonStreamingMs')))),
    h('section', { class: 'card' }, h('h2', {}, 'Privacy'),
      h('p', { class: 'small' }, DISCLOSURE_TEXT),
      ...providers.map((p) => h('div', { class: 'row small' }, h('span', { class: 'grow' }, p.label),
        s.disclosureAcks[p.vendor] === DISCLOSURE_VERSION ? h('span', { class: 'pill ok' }, 'acknowledged')
          : h('button', { onclick: () => act(async () => { ui.app.settings = await send('ackDisclosure', { provider: p.id }); }) }, 'Acknowledge')))),
    saveBar(s),
  );
}

/** Problems that would make the saved settings unusable; shown next to the Save button. */
function validateDraft(s) {
  const problems = [];
  const { min, max } = ITERATION_LIMIT;
  if (!Number.isInteger(s.iterationLimit) || s.iterationLimit < min || s.iterationLimit > max) problems.push(`Iteration limit must be a whole number from ${min} to ${max}.`);
  if (!Number.isFinite(s.defaultCapUsd) || s.defaultCapUsd < 0) problems.push('Default cap must be 0 or more.');
  for (const [name, cfg] of [['Generator', s.generator], ['Reviewer', s.reviewer]]) {
    if (!Number.isInteger(cfg.maxOutputTokens) || cfg.maxOutputTokens < 256) problems.push(`${name}: max output tokens must be a whole number of at least 256.`);
    if (!Number.isInteger(cfg.contextWindow) || cfg.contextWindow <= cfg.maxOutputTokens) problems.push(`${name}: context window must be larger than max output tokens.`);
  }
  for (const [k, v] of Object.entries(s.timeouts)) if (!Number.isFinite(v) || v <= 0) problems.push(`Timeout "${k}" must be more than 0 seconds.`);
  for (const [k, p] of Object.entries(s.pricing)) {
    if (p && [p.inputPerMTok, p.outputPerMTok].some((v) => v != null && (!Number.isFinite(v) || v < 0))) problems.push(`Price for ${k.split(':')[1]} must be 0 or more.`);
  }
  return problems;
}

async function saveDraft(s) {
  const problems = validateDraft(s);
  if (problems.length) {
    ui.saveStatus = { state: 'error', message: problems.join(' ') };
    render();
    return;
  }
  ui.saveStatus = { state: 'saving' };
  render();
  try {
    ui.app.settings = await send('saveSettings', { patch: { generator: s.generator, reviewer: s.reviewer, iterationLimit: s.iterationLimit, defaultCapUsd: s.defaultCapUsd, pricing: s.pricing, timeouts: s.timeouts } });
    ui.settingsDraft = null;
    ui.settingsNotice = null;
    ui.saveStatus = { state: 'saved' };
    setTimeout(() => {
      if (ui.saveStatus?.state === 'saved') { ui.saveStatus = null; if (ui.tab === 'settings') render(); }
    }, 6000);
  } catch (e) {
    ui.saveStatus = { state: 'error', message: `Could not save: ${e.message}` };
  }
  await refresh();
}

/** Save button pinned to the bottom of the panel, with its result shown right next to it. */
function saveBar(s) {
  const st = ui.saveStatus;
  const status = !st ? null
    : st.state === 'saving' ? h('span', { class: 'small muted' }, 'Saving…')
    : st.state === 'saved' ? h('span', { class: 'small', style: 'color:var(--ok)' }, '✓ Settings saved')
    : h('span', { class: 'small error' }, st.message);
  // Spacer first, so the message sits immediately to the left of the button, not at the far edge.
  return h('div', { class: 'row save-bar' },
    h('span', { class: 'grow' }),
    status,
    h('button', { class: 'primary', disabled: st?.state === 'saving', onclick: () => saveDraft(s) }, st?.state === 'saving' ? 'Saving…' : 'Save settings'));
}

/**
 * Price fields for the selected model. Built-in defaults fill in automatically (with their "as of"
 * date); editing a field saves a custom price for that model, and "Use default" removes it.
 */
function pricingInputs(s, cfg) {
  if (!cfg.model) return null;
  const key = `${cfg.provider}:${cfg.model}`;
  const def = defaultPricing(cfg.provider, cfg.model);
  const isCustom = hasPricing(s.pricing[key]);
  const shown = isCustom ? s.pricing[key] : def;

  const num = (field) => h('input', {
    type: 'number', min: '0', step: '0.01', value: shown?.[field] ?? '',
    placeholder: def ? '' : 'enter price',
    oninput: (e) => {
      // The first edit turns the default into a custom price for this model.
      const base = hasPricing(s.pricing[key]) ? s.pricing[key]
        : { inputPerMTok: def?.inputPerMTok ?? null, outputPerMTok: def?.outputPerMTok ?? null };
      s.pricing[key] = { ...base, [field]: e.target.value === '' ? null : Number(e.target.value) };
    },
  });

  let note;
  if (isCustom) {
    note = h('div', { class: 'row small' },
      h('span', { class: 'grow', style: 'color:var(--warn)' }, 'Custom price (your value)'),
      def ? h('button', { onclick: () => { s.pricing[key] = null; render(); } }, 'Use default') : null);
  } else if (def) {
    const extras = [];
    if (def.longContext) extras.push(`prompts over ${def.longContext.aboveTokens.toLocaleString()} tokens: $${def.longContext.inputPerMTok} / $${def.longContext.outputPerMTok}`);
    if (def.nextChange) extras.push(`changes to $${def.nextChange.input} / $${def.nextChange.output} on ${def.nextChange.from}`);
    note = h('div', { class: 'small muted' }, `Default price as of ${def.asOf}${extras.length ? ` · ${extras.join(' · ')}` : ''}. Edit to override.`);
  } else {
    note = h('div', { class: 'small error' }, "No built-in price for this model. Enter it from the provider's pricing page, or runs will need the budget cap disabled.");
  }
  return h('div', {},
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('label', {}, `Input $ / 1M tokens (${cfg.model})`), num('inputPerMTok')),
      h('div', { class: 'grow' }, h('label', {}, 'Output $ / 1M tokens'), num('outputPerMTok'))),
    note);
}

// ------------------------------------------------------------------ boot
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => {
    if (b.dataset.tab === 'settings' && ui.tab !== 'settings') { ui.settingsDraft = null; ui.settingsNotice = null; ui.saveStatus = null; } // fresh form on entry
    ui.tab = b.dataset.tab;
    render();
  });
}
const params = new URLSearchParams(location.search);
if (params.get('conversation')) ui.convId = params.get('conversation');
refresh();
