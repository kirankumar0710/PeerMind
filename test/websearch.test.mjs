import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADAPTERS } from '../src/providers/adapters.js';
import { streamCall } from '../src/providers/transport.js';
import { costUsd, checkReserve } from '../src/core/budget.js';
import { buildRequest } from '../src/core/context.js';
import { compileRegistry, toolsForModel, toolEnabled, jsonModeWithTools } from '../src/providers/tools.js';

const registry = compileRegistry(JSON.parse(readFileSync(new URL('../src/providers/tools.json', import.meta.url), 'utf8')));
const ws = (vendor, model) => toolsForModel(registry, vendor, model).find((t) => t.id === 'web_search');
const req = (model, tools = [], jsonMode = true) => ({ apiKey: 'k', model, system: 's', messages: [{ role: 'user', text: 'json please' }], maxOutputTokens: 4000, tools, jsonMode });

test('tools.json: web search variant per vendor and model (first match wins)', () => {
  assert.deepEqual(ws('openai', 'gpt-5.1').request, { type: 'web_search' });
  assert.equal(ws('openai', 'gpt-4.1-nano'), undefined);
  assert.equal(ws('openai', 'o3-mini'), undefined);
  assert.equal(ws('anthropic', 'claude-opus-5-5').request.type, 'web_search_20260209');
  assert.equal(ws('anthropic', 'claude-sonnet-4-6').request.type, 'web_search_20260209');
  assert.equal(ws('anthropic', 'claude-fable-5-2').request.type, 'web_search_20260209');
  assert.equal(ws('anthropic', 'claude-sonnet-4-5-20250929').request.type, 'web_search_20250305');
  assert.equal(ws('anthropic', 'claude-haiku-5-5').request.type, 'web_search_20250305');
  assert.equal(ws('anthropic', 'claude-opus-4-20250514').request.type, 'web_search_20250305');
  assert.equal(ws('anthropic', 'claude-3-haiku-20240307'), undefined);
  assert.deepEqual(ws('google', 'gemini-2.5-flash').request, { google_search: {} });
  assert.equal(ws('google', 'gemma-3-27b-it'), undefined);
  assert.equal(ws('anthropic', 'claude-opus-5-5').pricePerCall, 0.01);
  assert.equal(jsonModeWithTools(registry, 'openai'), false);
  assert.equal(jsonModeWithTools(registry, 'anthropic'), true);
});

test('tools.json: each variant returns its own copy of the request', () => {
  ws('openai', 'gpt-5.1').request.type = 'mutated';
  assert.equal(ws('openai', 'gpt-5.1').request.type, 'web_search');
});

test('tool switches: conversation value, legacy webSearch flag, then the default', () => {
  const tool = registry.tools.web_search;
  assert.equal(toolEnabled({}, tool), true);
  assert.equal(toolEnabled({ tools: { web_search: false } }, tool), false);
  assert.equal(toolEnabled({ webSearch: false }, tool), false);
  assert.equal(toolEnabled({ webSearch: false, tools: { web_search: true } }, tool), true);
  // The objects toolsForModel returns must work with toolEnabled too (they carry defaultEnabled).
  assert.equal(toolEnabled({}, ws('openai', 'gpt-5.1')), true);
});

test('invalid tools.json is rejected with a clear message', () => {
  assert.throws(() => compileRegistry({ schema: 'peermind.tools', version: 1, tools: { Bad: { label: 'x', result: 'pictures', vendors: { openai: [{ models: '(', request: {}, pricePerCall: -1 }] } } } }),
    /snake_case.*result "pictures".*bad models regex.*pricePerCall/);
});

test('request bodies send exactly the tools given; JSON mode follows the flag', () => {
  const o = ADAPTERS.openai.buildStreamRequest(req('gpt-5.1', [ws('openai', 'gpt-5.1').request], false)).body;
  assert.deepEqual(o.tools, [{ type: 'web_search' }]);
  assert.equal(o.text, undefined);
  const oOff = ADAPTERS.openai.buildStreamRequest(req('gpt-5.1')).body;
  assert.equal(oOff.tools, undefined);
  assert.deepEqual(oOff.text, { format: { type: 'json_object' } });

  assert.deepEqual(ADAPTERS.anthropic.buildStreamRequest(req('claude-opus-5-5', [ws('anthropic', 'claude-opus-5-5').request])).body.tools,
    [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
  assert.equal(ADAPTERS.anthropic.buildStreamRequest(req('claude-opus-5-5')).body.tools, undefined);

  const g = ADAPTERS.google.buildStreamRequest(req('gemini-2.5-pro', [{ google_search: {} }], false)).body;
  assert.deepEqual(g.tools, [{ google_search: {} }]);
  assert.equal(g.generationConfig.responseMimeType, undefined);
  assert.equal(ADAPTERS.google.buildStreamRequest(req('gemini-2.5-pro')).body.generationConfig.responseMimeType, 'application/json');
});

/** Run an adapter over scripted SSE lines through the real transport. */
async function run(adapter, lines) {
  const fetchImpl = async () => new Response(new ReadableStream({
    start(c) { const e = new TextEncoder(); for (const l of lines) c.enqueue(e.encode(l)); c.close(); },
  }), { status: 200 });
  return streamCall(adapter, req('m', [{ type: 'web_search' }], false), { apiKey: 'k', fetchImpl, timeouts: { streamingHeadersMs: 1000, firstContentMs: 1000, inactivityMs: 1000 } });
}
const sse = (event, obj) => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;

test('Anthropic: preamble before a search is dropped; citations become sources; searches counted', async () => {
  const r = await run(ADAPTERS.anthropic, [
    sse('message_start', { message: { usage: { input_tokens: 100 } } }),
    sse('content_block_delta', { delta: { type: 'text_delta', text: 'Let me search for that.' } }),
    sse('content_block_start', { content_block: { type: 'server_tool_use', name: 'web_search' } }),
    sse('content_block_start', { content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.example/x', title: 'A' }, { type: 'web_search_result', url: 'https://b.example/y', title: 'B' }] } }),
    sse('content_block_delta', { delta: { type: 'text_delta', text: '{"ok":' } }),
    sse('content_block_delta', { delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://b.example/y', title: 'B' } } }),
    sse('content_block_delta', { delta: { type: 'text_delta', text: 'true}' } }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50, server_tool_use: { web_search_requests: 1 } } }),
  ]);
  assert.equal(r.text, '{"ok":true}');
  assert.deepEqual(r.sources, [{ url: 'https://b.example/y', title: 'B' }]); // cited only
  assert.equal(r.usage.webSearches, 1);
});

test('Anthropic: pause_turn is reported as an error (resume not supported yet)', async () => {
  await assert.rejects(run(ADAPTERS.anthropic, [sse('message_delta', { delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 1 } })]),
    (e) => e.kind === 'provider' && /pause_turn/.test(e.message));
});

test('OpenAI: search completion resets preamble; url citations become sources', async () => {
  const d = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const r = await run(ADAPTERS.openai, [
    d({ type: 'response.output_text.delta', delta: 'Searching…' }),
    d({ type: 'response.web_search_call.searching' }),
    d({ type: 'response.web_search_call.completed' }),
    d({ type: 'response.output_text.delta', delta: '{"a":1}' }),
    d({ type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://news.example/n', title: 'News' } }),
    d({ type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'javascript:alert(1)', title: 'bad' } }),
    d({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } }),
  ]);
  assert.equal(r.text, '{"a":1}');
  assert.deepEqual(r.sources, [{ url: 'https://news.example/n', title: 'News' }]); // non-http links dropped
  assert.equal(r.usage.webSearches, 1);
});

test('Gemini: grounding chunks become sources; query count used for search fees', async () => {
  const d = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const r = await run(ADAPTERS.google, [
    d({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] }),
    d({ candidates: [{ finishReason: 'STOP', groundingMetadata: { webSearchQueries: ['q1', 'q2'], groundingChunks: [{ web: { uri: 'https://g.example/1', title: 'G1' } }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }),
  ]);
  assert.equal(r.text, '{"a":1}');
  assert.deepEqual(r.sources, [{ url: 'https://g.example/1', title: 'G1' }]);
  assert.equal(r.usage.webSearches, 2);
});

test('search fees are part of cost and of the budget reserve', () => {
  const p = { inputPerMTok: 3, outputPerMTok: 15, perSearchUsd: ws('anthropic', 'claude-sonnet-4-5').pricePerCall };
  assert.equal(p.perSearchUsd, 0.01);
  assert.equal(costUsd(p, 0, 0, 3), 0.03);
  assert.equal(checkReserve({ capUsd: 0.04, spentUsd: 0, enforced: true, items: [{ pricing: p, inputTokens: 0, outputTokens: 0, webSearches: 5 }] }).ok, false);
});

test('search rules are added to the system prompt only when web search is on', () => {
  const base = { kind: 'G_INITIAL', prompt: 'p', images: [], windowTokens: 100_000, maxOutputTokens: 1000 };
  assert.doesNotMatch(buildRequest(base).system, /web search tool/);
  assert.match(buildRequest({ ...base, webSearch: true }).system, /web search tool/);
  const r = buildRequest({ ...base, kind: 'R_REVIEW', webSearch: true, latestOutput: 'x', currentOpen: [], resolved: [], earlierUnresolved: [] });
  assert.match(r.system, /fact-check/);
});
