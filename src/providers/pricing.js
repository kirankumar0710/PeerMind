// Built-in default prices (USD per 1M tokens, standard tier, text). §6.1: adapters own pricing metadata.
//
// Provider model APIs do not return prices, so PeerMind ships this table. Every value is a DEFAULT:
// the user can override it per model in Settings, and the UI always shows the "as of" date.
// Update this file (and PRICES_AS_OF) whenever a provider changes its prices.
//
// Sources, checked 2026-11-21:
//   OpenAI    https://developers.openai.com/api/docs/pricing  (o4-mini: not on the page; widely published rate)
//   Google    https://aistudio.google.com/docs/pricing
//   Anthropic Claude API model reference (cached 2026-11-03); older Claude models from Anthropic's published rates
//
// Entry fields:
//   input / output           price per 1M tokens
//   longContext              optional higher tier: { aboveTokens, input, output } when the prompt exceeds aboveTokens
//   changes                  optional scheduled price changes: [{ from: 'YYYY-MM-DD', input, output }]

export const PRICES_AS_OF = '2026-11-21';
// Built-in tool fees (e.g. web search per call) live with the tools in src/providers/tools.json.

const P = (input, output, extra = {}) => ({ input, output, ...extra });

export const DEFAULT_PRICES = Object.freeze({
  openai: {
    'gpt-6.2-astra': P(8, 40),
    'gpt-6.2-sol': P(2, 10),
    'gpt-6.1-sol': P(2, 10),
    'gpt-6.1-terra': P(1, 5),
    'gpt-6-astra': P(10, 50),
    'gpt-6-sol': P(2, 10),
    'gpt-6-luna': P(0.10, 0.50),
    'gpt-5.6-sol': P(4, 20),
    'gpt-5.6-terra': P(2, 12),
    'gpt-5.6-luna': P(0.20, 1.20),
    'gpt-5.5': P(5, 30, { longContext: { aboveTokens: 272_000, input: 10, output: 45 } }),
    'gpt-5.5-pro': P(30, 180),
    'gpt-5.4': P(2.50, 15, { longContext: { aboveTokens: 272_000, input: 5, output: 22.50 } }),
    'gpt-5.4-pro': P(30, 180),
    'gpt-5.4-mini': P(0.75, 4.50),
    'gpt-5.4-nano': P(0.20, 1.25),
    'gpt-5.2': P(1.75, 14),
    'gpt-5.2-pro': P(21, 168),
    'gpt-5.1': P(1.25, 10),
    'gpt-5': P(1.25, 10),
    'gpt-5-mini': P(0.25, 2),
    'gpt-5-nano': P(0.05, 0.40),
    'gpt-5-pro': P(15, 120),
    'gpt-4.1': P(2, 8),
    'gpt-4.1-mini': P(0.40, 1.60),
    'gpt-4o': P(2.50, 10),
    'gpt-4o-mini': P(0.15, 0.60),
    o3: P(2, 8),
    'o3-pro': P(20, 80),
    'o4-mini': P(1.10, 4.40),
  },
  anthropic: {
    'claude-fable-5-2': P(8, 40),
    'claude-mythos-5-2': P(8, 40),
    'claude-fable-5-1': P(10, 50),
    'claude-mythos-5-1': P(10, 50),
    'claude-fable-5': P(10, 50),
    'claude-opus-5-5': P(4, 20),
    'claude-opus-5': P(5, 25),
    'claude-opus-4-8': P(5, 25),
    'claude-opus-4-7': P(5, 25),
    'claude-opus-4-6': P(5, 25),
    'claude-opus-4-5': P(5, 25),
    'claude-opus-4-1': P(15, 75),
    'claude-opus-4': P(15, 75),
    'claude-sonnet-5-5': P(2, 10),
    'claude-sonnet-5': P(2, 10),
    'claude-sonnet-4-6': P(3, 15),
    'claude-sonnet-4-5': P(3, 15),
    'claude-sonnet-4': P(3, 15),
    'claude-3-7-sonnet': P(3, 15),
    'claude-haiku-5-5': P(0.10, 0.50, { longContext: { aboveTokens: 100_000, input: 0.50, output: 2.50 } }),
    'claude-haiku-4-5': P(1, 5),
    'claude-3-5-haiku': P(0.80, 4),
  },
  google: {
    'gemini-4-carbon': P(2, 10, { changes: [{ from: '2026-12-01', input: 4, output: 20 }] }),
    'gemini-4-argon': P(2, 10, { changes: [{ from: '2026-12-01', input: 4, output: 20 }] }),
    'gemini-4-neon': P(3, 15),
    'gemini-4-hydrogen': P(1.50, 7.50),
    'gemini-3.8-flash': P(0.75, 3.75, { changes: [{ from: '2027-01-01', input: 1.50, output: 7.50 }] }),
    'gemini-3.6-flash': P(0.75, 3.75, { changes: [{ from: '2027-01-01', input: 1.50, output: 7.50 }] }),
    'gemini-3.5-flash-lite': P(0.30, 2.50),
    'gemini-3.1-pro-preview': P(2, 12),
    'gemini-3.1-flash-lite': P(0.25, 1.50),
    'gemini-3-flash-preview': P(0.50, 3),
    'gemini-2.5-pro': P(1.25, 10, { longContext: { aboveTokens: 200_000, input: 2.50, output: 15 } }),
    'gemini-2.5-flash': P(0.30, 2.50),
    'gemini-2.5-flash-lite': P(0.10, 0.40),
  },
});

// A model ID matches a table key exactly, or as key + a snapshot suffix (claude-sonnet-4-5-20250929,
// gpt-4o-2024-08-06, …-latest). Prefixes alone never match, so gpt-4o never prices gpt-4o-mini.
const SNAPSHOT_SUFFIX = /^(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/;

function findEntry(provider, modelId) {
  const table = DEFAULT_PRICES[provider];
  if (!table || !modelId) return null;
  if (table[modelId]) return { key: modelId, entry: table[modelId] };
  for (const [key, entry] of Object.entries(table)) {
    if (modelId.startsWith(`${key}-`) && SNAPSHOT_SUFFIX.test(modelId.slice(key.length + 1))) return { key, entry };
  }
  return null;
}

/**
 * Default pricing for a model on a given date, in the shape budget.js uses, or null when unknown.
 * @returns {{inputPerMTok:number, outputPerMTok:number, longContext?:object, source:'default', asOf:string,
 *            matchedModel:string, nextChange?:object} | null}
 */
export function defaultPricing(provider, modelId, today = new Date().toISOString().slice(0, 10)) {
  const found = findEntry(provider, modelId);
  if (!found) return null;
  const { entry } = found;
  let input = entry.input;
  let output = entry.output;
  let nextChange = null;
  for (const c of [...(entry.changes || [])].sort((a, b) => a.from.localeCompare(b.from))) {
    if (c.from <= today) { input = c.input; output = c.output; } else if (!nextChange) nextChange = c;
  }
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    ...(entry.longContext ? {
      longContext: { aboveTokens: entry.longContext.aboveTokens, inputPerMTok: entry.longContext.input, outputPerMTok: entry.longContext.output },
    } : {}),
    source: 'default',
    asOf: PRICES_AS_OF,
    matchedModel: found.key,
    ...(nextChange ? { nextChange } : {}),
  };
}
