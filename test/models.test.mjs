import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTERS, classifyOpenAiModel, classifyAnthropicModel, classifyGeminiModel,
  openAiCapabilities, anthropicCapabilities, geminiCapabilities,
} from '../src/providers/adapters.js';

test('OpenAI: chat/reasoning models supported; audio, image, embedding models not', () => {
  for (const id of ['gpt-4.1', 'gpt-4o-mini', 'o3', 'o4-mini', 'chatgpt-4o-latest']) assert.equal(classifyOpenAiModel(id).supported, true, id);
  for (const id of ['text-embedding-3-large', 'whisper-1', 'tts-1', 'dall-e-3', 'gpt-image-1', 'omni-moderation-latest',
    'gpt-4o-realtime-preview', 'gpt-4o-audio-preview', 'gpt-4o-transcribe', 'gpt-4o-search-preview', 'davinci-002']) {
    const c = classifyOpenAiModel(id);
    assert.equal(c.supported, false, id);
    assert.ok(c.reason);
  }
  assert.equal(classifyOpenAiModel('mystery-model').supported, false); // never assumed
});

test('Anthropic: Claude models supported', () => {
  assert.equal(classifyAnthropicModel('claude-sonnet-4-5').supported, true);
  assert.equal(classifyAnthropicModel('other').supported, false);
});

test('Gemini: requires generateContent and a text model', () => {
  assert.equal(classifyGeminiModel('gemini-2.5-pro', ['generateContent', 'countTokens']).supported, true);
  assert.equal(classifyGeminiModel('text-embedding-004', ['embedContent']).supported, false);
  assert.equal(classifyGeminiModel('gemini-2.5-flash-preview-tts', ['generateContent']).supported, false);
  assert.equal(classifyGeminiModel('imagen-3.0-generate-002', ['predict']).supported, false);
});

test('capabilities are detected from the model ID', () => {
  assert.deepEqual(openAiCapabilities('o3'), { reasoning: true, imageInput: true, thinkingIsOptional: false });
  assert.deepEqual(openAiCapabilities('o3-mini'), { reasoning: true, imageInput: false, thinkingIsOptional: false });
  assert.deepEqual(openAiCapabilities('gpt-4o-mini'), { reasoning: false, imageInput: true, thinkingIsOptional: false });
  assert.equal(openAiCapabilities('gpt-3.5-turbo').imageInput, false);

  assert.equal(anthropicCapabilities('claude-3-7-sonnet-20250219').reasoning, true);
  assert.equal(anthropicCapabilities('claude-3-5-sonnet-20241022').reasoning, false);
  assert.equal(anthropicCapabilities('claude-3-5-sonnet-20241022').imageInput, true);
  assert.equal(anthropicCapabilities('claude-sonnet-4-5').reasoning, true);
  assert.equal(anthropicCapabilities('claude-opus-4-1-20250805').reasoning, true);
  assert.equal(anthropicCapabilities('claude-2.1').imageInput, false);
  assert.equal(anthropicCapabilities('claude-sonnet-4-5').thinkingIsOptional, true);

  assert.equal(geminiCapabilities('gemini-2.5-pro').reasoning, true);
  assert.equal(geminiCapabilities('gemini-2.0-flash').reasoning, false);
  assert.equal(geminiCapabilities('gemini-2.0-flash').imageInput, true);
  assert.equal(geminiCapabilities('gemma-3-27b-it').imageInput, false); // unrecognised → not assumed
});

test('listModels returns every model the key can access, classified and sorted supported-first', async () => {
  const fetchImpl = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    models: [
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] },
    ],
  });
  try {
    const list = await ADAPTERS.google.listModels('AIza-test');
    assert.deepEqual(list.map((m) => [m.id, m.supported]), [['gemini-2.5-pro', true], ['text-embedding-004', false]]);
    assert.equal(list[0].contextWindow, 1048576);
  } finally {
    globalThis.fetch = fetchImpl;
  }
});
