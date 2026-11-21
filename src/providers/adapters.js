// First-party provider adapters (§6.1). Each adapter maps the vendor-neutral request
// { model, system, messages:[{role:'user'|'assistant', text, images:[{media_type, base64}]}],
//   maxOutputTokens, reasoning } to the vendor wire format, and vendor stream events back to
// { type: 'content'|'reasoning'|'usage'|'finish'|'error'|'meta' }.
import { jsonCall } from './transport.js';

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ---------------------------------------------------------------- OpenAI (Responses API)
const openai = {
  vendor: 'openai',
  label: 'OpenAI',
  async listModels(apiKey) {
    const r = await jsonCall('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` }, apiKey });
    return r.data.map((m) => ({ id: m.id })).sort((a, b) => a.id.localeCompare(b.id));
  },
  buildStreamRequest({ apiKey, model, system, messages, maxOutputTokens, reasoning }) {
    const input = messages.map((m) => (m.role === 'assistant'
      ? { role: 'assistant', content: [{ type: 'output_text', text: m.text }] }
      : {
        role: 'user',
        content: [
          { type: 'input_text', text: m.text },
          ...(m.images || []).map((i) => ({ type: 'input_image', image_url: `data:${i.media_type};base64,${i.base64}` })),
        ],
      }));
    const body = {
      model, instructions: system, input, stream: true, store: false,
      max_output_tokens: maxOutputTokens,
      text: { format: { type: 'json_object' } },
    };
    if (reasoning) body.reasoning = { summary: 'auto' }; // FR-092: request reasoning-summary stream
    return {
      url: 'https://api.openai.com/v1/responses',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body,
    };
  },
  parseEvent({ data }) {
    const e = safeJson(data);
    if (!e) return [{ type: 'meta' }];
    switch (e.type) {
      case 'response.output_text.delta': return [{ type: 'content', text: e.delta }];
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return [{ type: 'reasoning' }];
      case 'response.completed':
      case 'response.incomplete': {
        const u = e.response?.usage;
        return [
          { type: 'usage', inputTokens: u?.input_tokens ?? null, outputTokens: u?.output_tokens ?? null },
          { type: 'finish', reason: e.type === 'response.incomplete' ? (e.response?.incomplete_details?.reason || 'incomplete') : 'stop' },
        ];
      }
      case 'response.failed': return [{ type: 'error', message: e.response?.error?.message || 'Response failed.' }];
      case 'error': return [{ type: 'error', message: e.message || 'Provider error.' }];
      default: return [{ type: 'meta' }];
    }
  },
};

// ---------------------------------------------------------------- Anthropic (Messages API)
const ANTHROPIC_HEADERS = (apiKey) => ({
  'Content-Type': 'application/json',
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
});
const anthropic = {
  vendor: 'anthropic',
  label: 'Anthropic',
  async listModels(apiKey) {
    const r = await jsonCall('https://api.anthropic.com/v1/models?limit=1000', { headers: ANTHROPIC_HEADERS(apiKey), apiKey });
    return r.data.map((m) => ({ id: m.id, label: m.display_name }));
  },
  buildStreamRequest({ apiKey, model, system, messages, maxOutputTokens, reasoning }) {
    const body = {
      model, system, stream: true, max_tokens: maxOutputTokens,
      messages: messages.map((m) => (m.role === 'assistant'
        ? { role: 'assistant', content: [{ type: 'text', text: m.text }] }
        : {
          role: 'user',
          content: [
            ...(m.images || []).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.base64 } })),
            { type: 'text', text: m.text },
          ],
        })),
    };
    // FR-092: request the thinking stream. Budget must be >= 1024 and below max_tokens.
    if (reasoning && maxOutputTokens > 2048) {
      body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.floor(maxOutputTokens / 2)) };
    }
    return { url: 'https://api.anthropic.com/v1/messages', headers: ANTHROPIC_HEADERS(apiKey), body };
  },
  parseEvent({ event, data }) {
    const e = safeJson(data);
    if (!e) return [{ type: 'meta' }];
    switch (event) {
      case 'message_start':
        return [{ type: 'usage', inputTokens: e.message?.usage?.input_tokens ?? null }];
      case 'content_block_delta':
        if (e.delta?.type === 'text_delta') return [{ type: 'content', text: e.delta.text }];
        if (e.delta?.type === 'thinking_delta') return [{ type: 'reasoning' }];
        return [{ type: 'meta' }]; // signature_delta etc.
      case 'message_delta':
        return [
          { type: 'usage', outputTokens: e.usage?.output_tokens ?? null },
          ...(e.delta?.stop_reason ? [{ type: 'finish', reason: e.delta.stop_reason }] : []),
        ];
      case 'error': return [{ type: 'error', message: e.error?.message || 'Provider error.' }];
      default: return [{ type: 'meta' }]; // ping, message_stop, content_block_start/stop
    }
  },
};

// ---------------------------------------------------------------- Google Gemini (first-party API)
const gemini = {
  vendor: 'google',
  label: 'Google Gemini',
  async listModels(apiKey) {
    const r = await jsonCall('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': apiKey }, apiKey });
    return (r.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName, contextWindow: m.inputTokenLimit, maxOutput: m.outputTokenLimit }));
  },
  buildStreamRequest({ apiKey, model, system, messages, maxOutputTokens, reasoning }) {
    const generationConfig = { maxOutputTokens, responseMimeType: 'application/json' };
    if (reasoning) generationConfig.thinkingConfig = { includeThoughts: true }; // FR-092
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [
            { text: m.text },
            ...(m.images || []).map((i) => ({ inlineData: { mimeType: i.media_type, data: i.base64 } })),
          ],
        })),
        generationConfig,
      },
    };
  },
  parseEvent({ data }) {
    const e = safeJson(data);
    if (!e) return [{ type: 'meta' }];
    if (e.error) return [{ type: 'error', message: e.error.message || 'Provider error.' }];
    const out = [];
    const cand = e.candidates?.[0];
    for (const part of cand?.content?.parts || []) {
      if (part.thought) out.push({ type: 'reasoning' });
      else if (typeof part.text === 'string' && part.text.length) out.push({ type: 'content', text: part.text });
    }
    if (e.usageMetadata) {
      const u = e.usageMetadata;
      out.push({
        type: 'usage',
        inputTokens: u.promptTokenCount ?? null,
        outputTokens: u.candidatesTokenCount != null ? u.candidatesTokenCount + (u.thoughtsTokenCount || 0) : null,
      });
    }
    if (cand?.finishReason) out.push({ type: 'finish', reason: cand.finishReason });
    return out.length ? out : [{ type: 'meta' }];
  },
};

export const ADAPTERS = Object.freeze({ openai, anthropic, google: gemini });

// §6.2: identity is the underlying vendor; models and keys never create a new identity.
export const vendorOf = (providerId) => ADAPTERS[providerId]?.vendor ?? null;

export const PROVIDER_HOSTS = [
  'https://api.openai.com/*',
  'https://api.anthropic.com/*',
  'https://generativelanguage.googleapis.com/*',
];
