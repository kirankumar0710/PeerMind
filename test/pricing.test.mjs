import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPricing, DEFAULT_PRICES, PRICES_AS_OF } from '../src/providers/pricing.js';
import { costUsd, effectivePricing } from '../src/core/budget.js';
import { ADAPTERS, classifyOpenAiModel, classifyAnthropicModel, classifyGeminiModel } from '../src/providers/adapters.js';

test('exact IDs and snapshot suffixes match; prefixes alone never do', () => {
  assert.equal(defaultPricing('openai', 'gpt-5.1').inputPerMTok, 1.25);
  assert.equal(defaultPricing('openai', 'gpt-4o-2024-08-06').inputPerMTok, 2.50);
  assert.equal(defaultPricing('openai', 'gpt-4o-mini-2024-07-18').inputPerMTok, 0.15); // not gpt-4o
  assert.equal(defaultPricing('openai', 'gpt-4o-audio-preview'), null);
  assert.equal(defaultPricing('anthropic', 'claude-sonnet-4-5-20250929').outputPerMTok, 15);
  assert.equal(defaultPricing('anthropic', 'claude-opus-4-20250514').inputPerMTok, 15); // Opus 4, not 4.x
  assert.equal(defaultPricing('anthropic', 'claude-opus-5-5').inputPerMTok, 4);
  assert.equal(defaultPricing('google', 'gemini-2.5-pro').outputPerMTok, 10);
  assert.equal(defaultPricing('google', 'unknown-model'), null);
  assert.equal(defaultPricing('nope', 'gpt-5'), null);
  assert.equal(defaultPricing('openai', 'gpt-5').asOf, PRICES_AS_OF);
});

test('scheduled price changes apply from their date', () => {
  const before = defaultPricing('google', 'gemini-4-argon', '2026-11-30');
  assert.equal(before.inputPerMTok, 2);
  assert.deepEqual(before.nextChange, { from: '2026-12-01', input: 4, output: 20 });
  const after = defaultPricing('google', 'gemini-4-argon', '2026-12-01');
  assert.equal(after.inputPerMTok, 4);
  assert.equal(after.nextChange, undefined);
});

test('long-context rates apply above the threshold', () => {
  const p = defaultPricing('anthropic', 'claude-haiku-5-5');
  assert.equal(costUsd(p, 100_000, 0), 100_000 * 0.10 / 1e6);
  assert.equal(costUsd(p, 100_001, 1_000), (100_001 * 0.50 + 1_000 * 2.50) / 1e6);
});

test('a custom price wins over the default; incomplete custom falls back', () => {
  const def = defaultPricing('openai', 'gpt-5.1');
  assert.equal(effectivePricing({ inputPerMTok: 9, outputPerMTok: 9 }, def).source, 'custom');
  assert.equal(effectivePricing({ inputPerMTok: 9, outputPerMTok: null }, def).source, 'default');
  assert.equal(effectivePricing(null, null), null);
});

test('every table entry is a supported model for its provider', () => {
  for (const id of Object.keys(DEFAULT_PRICES.openai)) assert.equal(classifyOpenAiModel(id).supported, true, id);
  for (const id of Object.keys(DEFAULT_PRICES.anthropic)) assert.equal(classifyAnthropicModel(id).supported, true, id);
  for (const id of Object.keys(DEFAULT_PRICES.google)) assert.equal(classifyGeminiModel(id, ['generateContent']).supported, true, id);
});

test('Claude thinking request matches each model generation', () => {
  const body = (model, reasoning = true) => ADAPTERS.anthropic.buildStreamRequest({
    apiKey: 'k', model, system: 's', messages: [{ role: 'user', text: 'x' }], maxOutputTokens: 8000, reasoning,
  }).body.thinking;
  assert.deepEqual(body('claude-3-7-sonnet-20250219'), { type: 'enabled', budget_tokens: 4000 });
  assert.deepEqual(body('claude-haiku-4-5'), { type: 'enabled', budget_tokens: 4000 });
  assert.deepEqual(body('claude-opus-4-6'), { type: 'adaptive' });
  assert.deepEqual(body('claude-opus-4-8'), { type: 'adaptive', display: 'summarized' }); // budget_tokens would 400
  assert.deepEqual(body('claude-opus-5-5'), { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(body('claude-fable-5-2'), { type: 'adaptive', display: 'summarized' });
  assert.equal(body('claude-opus-4-8', false), undefined);
});
