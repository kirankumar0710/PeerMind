// MV3 service worker entry: message routing, panel connections, notifications (§11.2), recovery (§5.6).
import * as orch from './orchestrator.js';
import { ADAPTERS, vendorOf } from '../providers/adapters.js';
import { getSettings, saveSettings, setKey, removeKey, keyStatus, getKey } from '../storage/settings.js';
import { tx, get, deleteConversation } from '../storage/db.js';
import { enableActionOpensPanel, openConversationUi, notificationsAvailable } from '../compat/browser.js';
import { DISCLOSURE_VERSION, RunState } from '../core/constants.js';
import { isTerminal } from '../core/state-machine.js';
import { redact } from '../providers/transport.js';
import { loadToolRegistry, toolsForModel } from '../providers/tools.js';

// ---- panel connections: notifications are only issued while no panel is open
const panelPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  panelPorts.add(port);
  chrome.action.setBadgeText({ text: '' });
  port.onDisconnect.addListener(() => panelPorts.delete(port));
});

orch.onChange(async (evt) => {
  for (const p of panelPorts) { try { p.postMessage(evt); } catch { /* port closed */ } }
  if (evt.type === 'needsUser' && panelPorts.size === 0) await notifyNeedsUser(evt.run);
});

const STATE_TEXT = {
  [RunState.PAUSED_WAITING_FOR_USER]: 'is waiting for your input',
  [RunState.INTERRUPTED]: 'was interrupted and needs a decision',
  [RunState.FAILED]: 'failed and can be retried or abandoned',
};

// One notification per transition; no prompt, output or secrets in it.
async function notifyNeedsUser(run) {
  if (await notificationsAvailable()) {
    chrome.notifications.create(`pm:${run.conversationId}:${Date.now()}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'PeerMind needs your attention', message: `A run ${STATE_TEXT[run.state] || 'needs attention'}.`,
    });
  } else {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
  }
}

chrome.notifications?.onClicked.addListener((id) => {
  const [, conversationId] = id.split(':');
  chrome.notifications.clear(id);
  openConversationUi(conversationId);
});

chrome.runtime.onInstalled.addListener(() => enableActionOpensPanel());
chrome.runtime.onStartup.addListener(() => enableActionOpensPanel());

// Every worker start: anything that was executing lost continuity (§5.6). Never auto-resume.
const ready = orch.recoverOnStartup().catch((e) => console.error('PeerMind recovery failed', e));

// ---- request handlers
const handlers = {
  async getState() {
    const [settings, keys, conversations, runs] = await Promise.all([
      getSettings(), keyStatus(),
      tx(['conversations'], 'readonly', (s) => s.conversations.all()),
      tx(['runs'], 'readonly', (s) => s.runs.all()),
    ]);
    const lock = await get('meta', 'globalLock');
    const registry = await loadToolRegistry();
    const { focusConversation } = await chrome.storage.session.get('focusConversation');
    if (focusConversation) await chrome.storage.session.remove('focusConversation');
    return {
      settings, keys, globalLockRunId: lock?.runId || null, focusConversation: focusConversation || null,
      providers: Object.entries(ADAPTERS).map(([id, a]) => ({ id, label: a.label, vendor: a.vendor })),
      // Built-in tools from tools.json, for the panel's per-conversation switches.
      tools: Object.values(registry.tools).map(({ id, label, description, defaultEnabled }) => ({ id, label, description, defaultEnabled })),
      conversations: conversations
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((c) => {
          const unfinished = runs.find((r) => r.conversationId === c.id && !isTerminal(r.state));
          return { id: c.id, title: c.title, updatedAt: c.updatedAt, unfinishedState: unfinished?.state || null };
        }),
    };
  },
  async saveSettings({ patch }) {
    const allowed = ['generator', 'reviewer', 'iterationLimit', 'defaultCapUsd', 'pricing', 'timeouts'];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    return saveSettings(clean);
  },
  async setKey({ provider, key }) {
    if (!ADAPTERS[provider]) throw new Error('Unknown provider.');
    await setKey(provider, String(key).trim());
    return keyStatus();
  },
  async removeKey({ provider }) { await removeKey(provider); return keyStatus(); },
  async listModels({ provider }) {
    const key = await getKey(provider);
    if (!key) throw new Error('Add an API key first.');
    let models;
    try {
      models = await ADAPTERS[provider].listModels(key);
    } catch (e) {
      throw new Error(redact(e.message, key));
    }
    // Which built-in tools each model supports, from tools.json.
    const registry = await loadToolRegistry();
    return models.map((m) => ({
      ...m,
      capabilities: { ...m.capabilities, tools: toolsForModel(registry, ADAPTERS[provider].vendor, m.id).map((t) => t.id) },
    }));
  },
  async ackDisclosure({ provider }) {
    const s = await getSettings();
    return saveSettings({ disclosureAcks: { ...s.disclosureAcks, [vendorOf(provider)]: DISCLOSURE_VERSION } });
  },
  submitPrompt: (p) => orch.submitPrompt(p),
  stop: ({ runId }) => orch.stop(runId),
  retry: ({ runId }) => orch.retry(runId),
  resume: ({ runId, approveUnknown }) => orch.resume(runId, { approveUnknown }),
  abandon: ({ runId }) => orch.abandon(runId),
  disableBudgetEnforcement: ({ conversationId }) => orch.disableBudgetEnforcement(conversationId),
  updateConversation: ({ conversationId, patch }) => orch.updateConversation(conversationId, patch),
  async deleteConversation({ conversationId }) {
    const runs = await tx(['runs'], 'readonly', (s) => s.runs.byIndex('conversationId', conversationId));
    if (runs.some((r) => orch.isExecuting(r.id))) throw new Error('Stop the running run before deleting this conversation.');
    await deleteConversation(conversationId);
    return true;
  },
  async clearHistory() {
    const runs = await tx(['runs'], 'readonly', (s) => s.runs.all());
    if (runs.some((r) => orch.isExecuting(r.id))) throw new Error('Stop the running run before clearing history.');
    const convs = await tx(['conversations'], 'readonly', (s) => s.conversations.all());
    for (const c of convs) await deleteConversation(c.id);
    await tx(['meta'], 'readwrite', (s) => s.meta.delete('globalLock'));
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false; // only our own extension pages
  const handler = handlers[msg?.type];
  if (!handler) return false;
  ready
    .then(() => handler(msg))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});
