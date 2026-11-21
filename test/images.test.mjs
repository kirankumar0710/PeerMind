import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sniffImageType } from '../src/core/images.js';
import { ADAPTERS } from '../src/providers/adapters.js';
import { streamCall } from '../src/providers/transport.js';
import { compileRegistry, toolsForModel } from '../src/providers/tools.js';

const registry = compileRegistry(JSON.parse(readFileSync(new URL('../src/providers/tools.json', import.meta.url), 'utf8')));
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');

test('image type comes from the bytes, not from claims', () => {
  assert.equal(sniffImageType(Buffer.from(PNG, 'base64')), 'image/png');
  assert.equal(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageType(Buffer.from('RIFF0000WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImageType(Buffer.from('GIF89a...')), 'image/gif');
  assert.equal(sniffImageType(Buffer.from('<svg onload="x()">')), null); // SVG/HTML never accepted
  assert.equal(sniffImageType(new Uint8Array()), null);
});

test('tools.json: image generation is Generator-only, off by default, OpenAI tool models', () => {
  const g = toolsForModel(registry, 'openai', 'gpt-5.1', 'G').map((t) => t.id);
  const r = toolsForModel(registry, 'openai', 'gpt-5.1', 'R').map((t) => t.id);
  assert.deepEqual(g.sort(), ['image_generation', 'web_search']);
  assert.deepEqual(r, ['web_search']);
  assert.equal(registry.tools.image_generation.defaultEnabled, false);
  assert.equal(registry.tools.image_generation.result, 'image');
  assert.deepEqual(toolsForModel(registry, 'anthropic', 'claude-opus-5-5', 'G').map((t) => t.id), ['web_search']); // Claude can't draw
  const ig = toolsForModel(registry, 'openai', 'gpt-5.1', 'G').find((t) => t.id === 'image_generation');
  assert.equal(ig.request.type, 'image_generation');
  assert.match(ig.instructions.G, /image generation tool/);
});

test('OpenAI stream: image taken from the tool result once; preamble dropped; progress keeps it alive', async () => {
  const d = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const item = { id: 'ig_1', type: 'image_generation_call', status: 'completed', result: PNG };
  const lines = [
    d({ type: 'response.output_text.delta', delta: 'Drawing your cat…' }),
    d({ type: 'response.image_generation_call.in_progress' }),
    d({ type: 'response.image_generation_call.partial_image', partial_image_index: 0, partial_image_b64: 'cHJldmlldw==' }),
    d({ type: 'response.output_item.done', item }),
    d({ type: 'response.output_text.delta', delta: '{"a":1}' }),
    d({ type: 'response.completed', response: { output: [item], usage: { input_tokens: 10, output_tokens: 5 } } }),
  ];
  const fetchImpl = async () => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const l of lines) c.enqueue(e.encode(l)); c.close(); } }));
  const r = await streamCall(ADAPTERS.openai, { model: 'gpt-5.1', system: 's', messages: [{ role: 'user', text: 'x' }], maxOutputTokens: 100, tools: [{ type: 'image_generation' }], jsonMode: false },
    { apiKey: 'k', fetchImpl, timeouts: { streamingHeadersMs: 1000, firstContentMs: 1000, inactivityMs: 1000 } });
  assert.equal(r.text, '{"a":1}');
  assert.deepEqual(r.images, [PNG]); // partial preview ignored; duplicate in response.completed ignored
  assert.equal(r.usage.images, 1);
});

test('refine requests carry the previous image as input for editing', () => {
  const body = ADAPTERS.openai.buildStreamRequest({
    apiKey: 'k', model: 'gpt-5.1', system: 's', maxOutputTokens: 100, tools: [{ type: 'image_generation' }], jsonMode: false,
    messages: [{ role: 'user', text: 'edit it', images: [{ asset_id: 'PM-A-0001', media_type: 'image/png', base64: PNG }] }],
  }).body;
  assert.deepEqual(body.input[0].content[1], { type: 'input_image', image_url: `data:image/png;base64,${PNG}` });
});
