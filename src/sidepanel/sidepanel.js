// Side panel UI (§12). UI only (FR-041): all execution happens in the service worker.
// Untrusted content is only ever rendered with textContent, never as HTML.
import { loadConversation } from '../storage/db.js';
import { buildExportZip } from '../export/export.js';
import { summarizeUsage } from '../core/budget.js';
import {
  RunState as S, CompletionReason as CR, DISCLOSURE_TEXT, DISCLOSURE_VERSION, ITERATION_LIMIT, ReviewStatus, OpState,
} from '../core/constants.js';
import { bytesToBase64, MEDIA_EXT } from '../core/util.js';

const ui = {
  tab: 'run', app: null, convId: null, data: null, attachments: [], promptDraft: '',
  error: null, thinkingOp: null, models: {}, providerMsg: {},
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

const port = chrome.runtime.connect({ name: 'panel' });
port.onMessage.addListener((evt) => {
  if (evt.type === 'activity') { ui.thinkingOp = evt.opId; return; }
  scheduleRefresh();
});

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
      `Iteration limit ${s.iterationLimit} · max output G ${s.generator.maxOutputTokens} / R ${s.reviewer.maxOutputTokens} tokens`),
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
  const parts = [configSummary()];
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
        h('div', { class: 'row', style: 'margin-bottom:6px' }, outRun.state === S.FINISHED || outRun.reviewStatus ? reviewPill(outRun)
          : h('span', { class: `pill ${outRun.latestOutputReviewed ? 'info' : 'warn'}` }, outRun.latestOutputReviewed ? 'reviewed, run in progress' : 'awaiting review')),
        h('div', { class: 'output' }, outMsg.text || '(empty response)'),
        (outRun.downgradeDependencies || []).length ? h('div', { class: 'small' }, h('h3', {}, 'Severity downgrades this completion depends on'),
          ...outRun.downgradeDependencies.map((dg) => h('div', {}, `${dg.finding_id}: ${dg.from} → ${dg.to} — ${dg.reason}`))) : null));
    }
    parts.push(findingsCard(d, run), iterationsCard(d), timelineCard(d));
  }
  parts.push(promptCard());
  root.replaceChildren(...parts.filter(Boolean));
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
    explain.push(h('span', { class: 'thinking' }, st === S.PREFLIGHT ? 'Checking providers' : `Working: ${run.cursor.kind.replace('_', ' ').toLowerCase()} (refinements ${run.cursor.refinementsDone}/${run.config?.iterationLimit ?? '?'})`));
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

function iterationsCard(d) {
  const items = d.messages.map((m) => {
    if (m.kind === 'user') return h('details', {}, h('summary', {}, `You · ${time(m.createdAt)}`), h('div', { class: 'output' }, m.text || '(image only)'), m.assetIds?.length ? h('div', { class: 'small muted' }, m.assetIds.join(', ')) : null);
    if (m.kind === 'g_output') {
      return h('details', {}, h('summary', {}, h('span', { class: 'role-g' }, m.refinementNo ? `G${m.refinementNo} refinement` : 'G0 initial'), ` · ${m.summary}`),
        m.decisions?.length ? h('table', {}, h('tbody', {}, m.decisions.map((x) => h('tr', {}, h('td', {}, x.finding_id), h('td', {}, x.decision), h('td', {}, x.reason))))) : null,
        h('div', { class: 'output' }, m.text));
    }
    if (m.kind === 'r_report') {
      return h('details', {}, h('summary', {}, h('span', { class: 'role-r' }, m.closing ? 'Closing review' : 'Review'), ` · ${m.status} · ${m.summary}`),
        h('pre', {}, JSON.stringify(m.findings, null, 2)));
    }
    return null;
  });
  return h('section', { class: 'card' }, h('h2', {}, 'Iteration history'), items);
}

function timelineCard(d) {
  const usage = summarizeUsage(d.operations);
  const rows = d.operations.map((o) => h('details', {},
    h('summary', {}, h('span', { class: o.role === 'G' ? 'role-g' : 'role-r' }, o.purpose), ` · ${providerLabel(o.provider)} ${o.model} · ${time(o.startedAt)} · `,
      h('span', { class: `pill ${o.state === OpState.SUCCEEDED ? 'ok' : o.state === OpState.IN_PROGRESS ? 'info' : 'bad'}` }, o.state),
      o.state === OpState.IN_PROGRESS && ui.thinkingOp === o.id ? h('span', { class: 'thinking small' }, ' Thinking') : null),
    h('div', { class: 'small' }, `Sent to: ${providerLabel(o.provider)} · tokens in ${o.usage?.inputTokens ?? 'n/a'} / out ${o.usage?.outputTokens ?? 'n/a'} · cost ${money(o.costUsd)}`),
    o.error ? h('div', { class: 'small error' }, o.error.message || (o.error.errors || []).join(' ')) : null,
    h('details', {}, h('summary', { class: 'small' }, 'Context sent'), h('pre', {}, JSON.stringify(o.contextSent, null, 2))),
    o.partial && o.state !== OpState.SUCCEEDED ? h('details', {}, h('summary', { class: 'small' }, 'Partial output'), h('pre', {}, o.partial)) : null));
  return h('section', { class: 'card' }, h('h2', {}, 'Timeline'), rows,
    h('h3', {}, 'Usage by role'),
    ...usage.byRole.map((r) => h('div', { class: 'small' }, `${r.role} · ${providerLabel(r.provider)}: ${r.inputTokens} in / ${r.outputTokens} out · ${r.costIncomplete && !r.costUsd ? 'Not available' : money(r.costUsd)}`)));
}

function promptCard() {
  const d = ui.data;
  const unfinished = d?.runs.some((r) => r.state !== S.FINISHED && r.state !== S.ABANDONED);
  const readOnly = d?.conversation.readOnly;
  const s = ui.app.settings;
  const sameVendor = ui.app.providers.find((p) => p.id === s.generator.provider)?.vendor === ui.app.providers.find((p) => p.id === s.reviewer.provider)?.vendor;
  const notReady = !s.generator.model || !s.reviewer.model || sameVendor || !ui.app.keys[s.generator.provider] || !ui.app.keys[s.reviewer.provider];
  const blocked = unfinished || readOnly || notReady;

  const ta = h('textarea', { placeholder: d ? 'Next prompt in this conversation…' : 'What should the two models work on?', oninput: (e) => { ui.promptDraft = e.target.value; } });
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
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, d ? d.conversation.title : 'New conversation'),
      d ? h('button', { onclick: () => { ui.convId = null; ui.data = null; render(); } }, 'New conversation') : null),
    ta,
    h('div', { class: 'thumbs' }, ui.attachments.map((a, i) => h('img', { src: a.url, title: 'Click to remove', onclick: () => { ui.attachments.splice(i, 1); render(); } }))),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('label', { style: 'margin:0' }, 'Images ', file),
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
function renderSettings() {
  const root = document.getElementById('tab-settings');
  const s = structuredClone(ui.app.settings);
  const providers = ui.app.providers;

  const keyRows = providers.map((p) => {
    const input = h('input', { type: 'password', placeholder: ui.app.keys[p.id] ? `Saved: ${ui.app.keys[p.id]}` : 'API key', autocomplete: 'off' });
    return h('div', { class: 'list-item' },
      h('div', { style: 'width:110px' }, p.label),
      h('div', { class: 'grow' }, input, ui.providerMsg[p.id] ? h('div', { class: 'small muted' }, ui.providerMsg[p.id]) : null),
      h('button', { onclick: () => act(async () => { await send('setKey', { provider: p.id, key: input.value }); }) }, 'Save'),
      h('button', { disabled: !ui.app.keys[p.id], onclick: () => act(async () => {
        try {
          const models = await send('listModels', { provider: p.id });
          ui.models[p.id] = models;
          ui.providerMsg[p.id] = `Connected · ${models.length} models`;
        } catch (e) { ui.providerMsg[p.id] = `Test failed: ${e.message}`; }
      }) }, 'Test'),
      h('button', { class: 'danger', disabled: !ui.app.keys[p.id], onclick: () => act(() => send('removeKey', { provider: p.id })) }, 'Remove'));
  });

  const roleSection = (key, title, cls) => {
    const cfg = s[key];
    const listId = `models-${key}`;
    const models = ui.models[cfg.provider] || [];
    return h('div', {},
      h('h3', {}, h('span', { class: cls }, title)),
      h('label', {}, 'Provider'),
      h('select', { onchange: (e) => { cfg.provider = e.target.value; cfg.model = ''; } },
        providers.map((p) => h('option', { value: p.id, selected: p.id === cfg.provider }, `${p.label} (vendor: ${p.vendor})`))),
      h('label', {}, 'Model'),
      h('div', { class: 'row' },
        h('input', { class: 'grow', list: listId, value: cfg.model, oninput: (e) => {
          cfg.model = e.target.value;
          const m = models.find((x) => x.id === cfg.model);
          if (m?.contextWindow) cfg.contextWindow = m.contextWindow;
        } }),
        h('button', { onclick: () => act(async () => { ui.models[cfg.provider] = await send('listModels', { provider: cfg.provider }); ui.app.settings = await send('saveSettings', { patch: { [key]: cfg } }); }) }, 'Load models')),
      h('datalist', { id: listId }, models.map((m) => h('option', { value: m.id }, m.label || m.id))),
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', {}, 'Max output tokens'), h('input', { type: 'number', min: '256', value: cfg.maxOutputTokens, oninput: (e) => { cfg.maxOutputTokens = parseInt(e.target.value, 10); } })),
        h('div', { class: 'grow' }, h('label', {}, 'Context window (tokens)'), h('input', { type: 'number', min: '1024', value: cfg.contextWindow, oninput: (e) => { cfg.contextWindow = parseInt(e.target.value, 10); } }))),
      h('label', {}, h('input', { type: 'checkbox', checked: cfg.reasoning, onchange: (e) => { cfg.reasoning = e.target.checked; } }), ' Reasoning model: request reasoning/thinking stream (keeps slow responses alive; content never shown or stored)'),
      h('label', {}, h('input', { type: 'checkbox', checked: cfg.imageInput, onchange: (e) => { cfg.imageInput = e.target.checked; } }), ' Model supports image input'),
      pricingInputs(s, cfg));
  };

  const t = s.timeouts;
  const sec = (field) => h('input', { type: 'number', min: '1', value: Math.round(t[field] / 1000), oninput: (e) => { t[field] = Number(e.target.value) * 1000; } });

  root.replaceChildren(
    h('section', { class: 'card' }, h('h2', {}, 'Provider API keys'),
      h('div', { class: 'small muted' }, 'Keys are masked and held for this browser session only; they are cleared when the browser closes and never appear in prompts, logs or exports.'),
      keyRows),
    h('section', { class: 'card' }, h('h2', {}, 'Roles'),
      roleSection('generator', 'Generator (G)', 'role-g'),
      roleSection('reviewer', 'Reviewer (R)', 'role-r')),
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
    h('div', { class: 'row' }, h('span', { class: 'grow' }),
      h('button', { class: 'primary', onclick: () => act(async () => {
        ui.app.settings = await send('saveSettings', { patch: { generator: s.generator, reviewer: s.reviewer, iterationLimit: s.iterationLimit, defaultCapUsd: s.defaultCapUsd, pricing: s.pricing, timeouts: s.timeouts } });
      }) }, 'Save settings')),
  );
}

function pricingInputs(s, cfg) {
  if (!cfg.model) return null;
  const key = `${cfg.provider}:${cfg.model}`;
  const p = (s.pricing[key] ||= { inputPerMTok: null, outputPerMTok: null });
  const num = (field) => h('input', { type: 'number', min: '0', step: '0.01', value: p[field] ?? '', oninput: (e) => { p[field] = e.target.value === '' ? null : Number(e.target.value); } });
  return h('div', { class: 'row' },
    h('div', { class: 'grow' }, h('label', {}, `Input $ / 1M tokens (${cfg.model})`), num('inputPerMTok')),
    h('div', { class: 'grow' }, h('label', {}, 'Output $ / 1M tokens'), num('outputPerMTok')));
}

// ------------------------------------------------------------------ boot
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => { ui.tab = b.dataset.tab; render(); });
}
const params = new URLSearchParams(location.search);
if (params.get('conversation')) ui.convId = params.get('conversation');
refresh();
