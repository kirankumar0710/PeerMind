// Non-secret settings in chrome.storage.local; API keys in chrome.storage.session only (§6.3, FR-005).
import { DEFAULT_TIMEOUTS, ITERATION_LIMIT } from '../core/constants.js';

const roleDefaults = (provider) => ({
  provider,
  model: '',
  maxOutputTokens: 8192,
  contextWindow: 128000,
  // Reasoning streams and image input are detected from the model, not configured.
  // The only user choice: Claude extended thinking (changes cost and output).
  extendedThinking: false,
});

export const DEFAULT_SETTINGS = Object.freeze({
  generator: roleDefaults('openai'),
  reviewer: roleDefaults('anthropic'),
  iterationLimit: ITERATION_LIMIT.default,
  defaultCapUsd: 1,
  pricing: {},          // { "openai:gpt-x": { inputPerMTok, outputPerMTok } }
  timeouts: { ...DEFAULT_TIMEOUTS },
  disclosureAcks: {},   // { vendor: DISCLOSURE_VERSION }
});

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = settings || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    generator: { ...DEFAULT_SETTINGS.generator, ...s.generator },
    reviewer: { ...DEFAULT_SETTINGS.reviewer, ...s.reviewer },
    timeouts: { ...DEFAULT_SETTINGS.timeouts, ...s.timeouts },
    pricing: { ...s.pricing },
    disclosureAcks: { ...s.disclosureAcks },
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export const pricingKey = (provider, model) => `${provider}:${model}`;

// ---- Credentials: session-only, never logged, exported or sent anywhere but the provider.
export async function getKey(provider) {
  const { keys } = await chrome.storage.session.get('keys');
  return keys?.[provider] || null;
}
export async function setKey(provider, key) {
  const { keys } = await chrome.storage.session.get('keys');
  await chrome.storage.session.set({ keys: { ...keys, [provider]: key } });
}
export async function removeKey(provider) {
  const { keys } = await chrome.storage.session.get('keys');
  const next = { ...keys };
  delete next[provider];
  await chrome.storage.session.set({ keys: next });
}
export async function keyStatus() {
  const { keys } = await chrome.storage.session.get('keys');
  return Object.fromEntries(Object.entries(keys || {}).map(([p, k]) => [p, k ? `${k.slice(0, 4)}…${k.slice(-4)}` : null]));
}
