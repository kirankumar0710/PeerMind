// §9 usage, pricing and budget reserve. Pure functions. All costs are estimates (FR-084).

/** pricing: { inputPerMTok, outputPerMTok } in USD per million tokens, or null when unknown. */
export function hasPricing(pricing) {
  return !!pricing && Number.isFinite(pricing.inputPerMTok) && Number.isFinite(pricing.outputPerMTok) &&
    pricing.inputPerMTok >= 0 && pricing.outputPerMTok >= 0;
}

/**
 * Returns USD or null ("Not available") when pricing or token counts are missing.
 * When the prompt exceeds pricing.longContext.aboveTokens, the long-context rates apply to the whole call.
 */
export function costUsd(pricing, inputTokens, outputTokens, toolCalls = {}) {
  if (!hasPricing(pricing) || !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const lc = pricing.longContext;
  const rates = lc && inputTokens > lc.aboveTokens && hasPricing(lc) ? lc : pricing;
  // Built-in tool fees: toolCalls { web_search: n, image_generation: n } × pricing.toolFees (from tools.json).
  let toolCost = 0;
  for (const [id, n] of Object.entries(toolCalls || {})) toolCost += (n || 0) * (pricing.toolFees?.[id] || 0);
  return (inputTokens * rates.inputPerMTok + outputTokens * rates.outputPerMTok) / 1e6 + toolCost;
}

/** Map an operation's usage counters to tool calls for costUsd. */
export const toolCallsOf = (usage) => ({ web_search: usage?.webSearches || 0, image_generation: usage?.images || 0 });

/** A user-entered token price wins; otherwise the built-in default; otherwise null. Tool fees are added from tools.json. */
export function effectivePricing(override, fallback) {
  if (hasPricing(override)) return { ...override, source: 'custom' };
  return fallback || null;
}

/**
 * §9.3 reserve check. `items` are the operations that must all be affordable before the next
 * operation starts: for a G output, [G, required background ops, following R review].
 *
 * @returns {{ok: boolean, reason?: 'MISSING_PRICING'|'BUDGET', requiredUsd?: number, remainingUsd?: number}}
 */
export function checkReserve({ capUsd, spentUsd, enforced, items }) {
  if (!enforced) return { ok: true };
  let required = 0;
  for (const it of items) {
    const c = costUsd(it.pricing, it.inputTokens, it.outputTokens, it.toolCalls || {});
    if (c === null) return { ok: false, reason: 'MISSING_PRICING' };
    required += c;
  }
  const remaining = capUsd - spentUsd;
  return required <= remaining
    ? { ok: true, requiredUsd: required, remainingUsd: remaining }
    : { ok: false, reason: 'BUDGET', requiredUsd: required, remainingUsd: remaining };
}

/** Sum recorded operation costs; operations without a cost contribute nothing but are flagged. */
export function summarizeUsage(operations) {
  const total = { inputTokens: 0, outputTokens: 0, costUsd: 0, costIncomplete: false };
  const byRole = {};
  for (const op of operations) {
    const key = `${op.role}:${op.provider}`;
    const r = (byRole[key] ||= { role: op.role, provider: op.provider, inputTokens: 0, outputTokens: 0, costUsd: 0, costIncomplete: false });
    for (const acc of [total, r]) {
      acc.inputTokens += op.usage?.inputTokens || 0;
      acc.outputTokens += op.usage?.outputTokens || 0;
      if (op.costUsd == null) { if (op.usage) acc.costIncomplete = true; } else acc.costUsd += op.costUsd;
    }
  }
  return { total, byRole: Object.values(byRole) };
}
