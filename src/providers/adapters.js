// First-party provider adapters (§6.1). Each adapter maps the vendor-neutral request
// { model, system, messages:[{role:'user'|'assistant', text, images:[{media_type, base64}]}],
//   maxOutputTokens, reasoning } to the vendor wire format, and vendor stream events back to
// { type: 'content'|'reasoning'|'usage'|'finish'|'error'|'meta' }.
import { jsonCall, MAX_ERROR_CHARS } from './transport.js';

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * An in-stream error event is reported exactly as the provider sent it (the raw event data),
 * truncated only if very long. No interpretation: the provider's own text is the most useful
 * diagnosis. The transport redacts secrets before it reaches logs, storage or the UI.
 */
export function rawStreamError(data) {
  const raw = String(data ?? '').trim();
  return raw.length > MAX_ERROR_CHARS ? `${raw.slice(0, MAX_ERROR_CHARS)}…` : raw || '(empty error event)';
}

// ---------------------------------------------------------------- model support classification
// A provider's model list only contains models the API key can access. These classifiers decide
// whether a listed model can run PeerMind's text-generation protocol. Unsupported operations are
// never assumed (§6.1): anything unrecognised is reported as unsupported, with a reason.
const supported = { supported: true, reason: null };
const unsupported = (reason) => ({ supported: false, reason });

export function classifyOpenAiModel(id) {
  const m = id.match(/embedding|whisper|tts|dall-e|gpt-image|image|moderation|realtime|audio|transcribe|search|davinci|babbage|computer-use|sora/);
  if (m) return unsupported(`${m[0]} model, not text generation`);
  if (/^(gpt-|o\d|chatgpt-)/.test(id)) return supported;
  return unsupported('not a recognised text-generation model');
}

export function classifyAnthropicModel(id) {
  return id.startsWith('claude') ? supported : unsupported('not a recognised Claude model');
}

export function classifyGeminiModel(id, methods = []) {
  if (!methods.includes('generateContent')) return unsupported('does not support generateContent');
  const m = id.match(/embedding|aqa|imagen|veo|tts|native-audio|live/);
  if (m) return unsupported(`${m[0]} model, not text generation`);
  return supported;
}

// ---------------------------------------------------------------- capability detection
// Provider model lists do not report these, so they are derived from the model ID and shown to the
// user as information. Anything unrecognised is reported as not supported (§6.1).
//   reasoning:  the model emits a reasoning/thinking stream PeerMind can request (FR-092)
//   imageInput: the model accepts images in the prompt (§8.1)
//   thinkingIsOptional: reasoning is a separate opt-in that changes cost and output (Claude extended thinking)
//   Built-in tools (web search, …) are NOT detected here: they come from src/providers/tools.json.

export function openAiCapabilities(id) {
  return {
    reasoning: /^(o\d|gpt-[5-9])/.test(id),
    imageInput: /^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-[5-9]|chatgpt-4o|o1(?!-mini)|o3(?!-mini)|o4)/.test(id),
    thinkingIsOptional: false,
  };
}

/**
 * Claude IDs look like claude-3-7-sonnet-20250219, claude-sonnet-4-5, claude-opus-5-5, claude-fable-5-2.
 * thinkingMode decides how the adapter requests thinking:
 *   'budget'          3.7 – 4.5: {type:'enabled', budget_tokens} — optional (user opt-in)
 *   'adaptive'        4.6 – 4.8: {type:'adaptive'} — optional (user opt-in); budget_tokens is rejected on 4.7+
 *   'always'          5.x and later: thinking is on by default and cannot always be disabled, so it is
 *                     always requested (with summarized display, so progress events keep the stream alive)
 */
export function anthropicCapabilities(id) {
  const m = id.match(/^claude-(?:[a-z]+-)?(\d+)(?:-(\d)(?!\d))?/);
  const major = m ? Number(m[1]) : 0;
  const minor = m && m[2] ? Number(m[2]) : 0;
  const v = major + minor / 10;
  const thinkingMode = v >= 5 ? 'always' : v >= 4.6 ? 'adaptive' : v >= 3.7 ? 'budget' : null;
  return {
    reasoning: thinkingMode !== null,
    imageInput: major >= 3,
    thinkingIsOptional: thinkingMode === 'budget' || thinkingMode === 'adaptive',
    thinkingMode,
    version: v,
  };
}

export function geminiCapabilities(id) {
  return {
    reasoning: /^gemini-(2\.5|[3-9])/.test(id),
    imageInput: /^gemini-/.test(id),
    thinkingIsOptional: false,
  };
}

const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const source = (url, title, cited) => (isHttpUrl(url) ? [{ type: 'source', url, title: title || url, cited }] : []);

/** Supported models first, then alphabetical. */
const sortModels = (list) => list.sort((a, b) => (b.supported - a.supported) || a.id.localeCompare(b.id));

// ---------------------------------------------------------------- OpenAI (Responses API)
const openai = {
  vendor: 'openai',
  label: 'OpenAI',
  async listModels(apiKey) {
    const r = await jsonCall('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` }, apiKey });
    return sortModels(r.data.map((m) => ({ id: m.id, ...classifyOpenAiModel(m.id), capabilities: openAiCapabilities(m.id) })));
  },
  buildStreamRequest({ apiKey, model, system, messages, maxOutputTokens, reasoning, tools = [], jsonMode = true }) {
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
    };
    // Built-in tools from tools.json, sent as written; the model decides when to use them.
    if (tools.length) body.tools = tools;
    // JSON mode can be off with tools (tools.json vendorOptions); the prompt and the strict
    // validator still require a single JSON object.
    if (jsonMode) body.text = { format: { type: 'json_object' } };
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
      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching':
        return [{ type: 'activity' }];
      case 'response.web_search_call.completed':
        // Text written before a search is preamble, not the answer.
        return [{ type: 'search' }, { type: 'content-reset' }];
      case 'response.output_text.annotation.added':
        return e.annotation?.type === 'url_citation' ? source(e.annotation.url, e.annotation.title, true) : [{ type: 'meta' }];
      case 'response.completed':
      case 'response.incomplete': {
        const u = e.response?.usage;
        return [
          { type: 'usage', inputTokens: u?.input_tokens ?? null, outputTokens: u?.output_tokens ?? null },
          { type: 'finish', reason: e.type === 'response.incomplete' ? (e.response?.incomplete_details?.reason || 'incomplete') : 'stop' },
        ];
      }
      case 'response.failed':
      case 'error':
        return [{ type: 'error', message: rawStreamError(data) }];
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
    return sortModels(r.data.map((m) => ({
      id: m.id, label: m.display_name, ...classifyAnthropicModel(m.id), capabilities: anthropicCapabilities(m.id),
      // The Models API reports the context window and output cap (since Mar 2026).
      ...(Number.isFinite(m.max_input_tokens) ? { contextWindow: m.max_input_tokens } : {}),
      ...(Number.isFinite(m.max_tokens) ? { maxOutput: m.max_tokens } : {}),
    })));
  },
  buildStreamRequest({ apiKey, model, system, messages, maxOutputTokens, reasoning, tools = [] }) {
    const caps = anthropicCapabilities(model);
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
    // FR-092: request the thinking stream in the form each Claude generation accepts.
    // Thinking text is only a liveness signal here; it is never shown, stored or exported (FR-093).
    if (reasoning) {
      if (caps.thinkingMode === 'budget') {
        // 3.7 – 4.5: budget must be >= 1024 and below max_tokens.
        if (maxOutputTokens > 2048) body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.floor(maxOutputTokens / 2)) };
      } else if (caps.thinkingMode === 'adaptive' && caps.version < 4.7) {
        body.thinking = { type: 'adaptive' }; // 4.6 streams summarized thinking by default
      } else if (caps.thinkingMode) {
        // 4.7+ and 5.x default to display "omitted" (empty thinking text); ask for summaries so
        // thinking produces stream events that keep the inactivity timers alive.
        body.thinking = { type: 'adaptive', display: 'summarized' };
      }
    }
    // Built-in (server) tools from tools.json, sent as written; Claude decides when to use them.
    if (tools.length) body.tools = tools;
    return { url: 'https://api.anthropic.com/v1/messages', headers: ANTHROPIC_HEADERS(apiKey), body };
  },
  parseEvent({ event, data }) {
    const e = safeJson(data);
    if (!e) return [{ type: 'meta' }];
    switch (event) {
      case 'message_start':
        return [{ type: 'usage', inputTokens: e.message?.usage?.input_tokens ?? null }];
      case 'content_block_start': {
        const cb = e.content_block || {};
        if (cb.type === 'server_tool_use') return [cb.name === 'web_search' ? { type: 'search' } : { type: 'activity' }];
        if (typeof cb.type === 'string' && cb.type.endsWith('_tool_result')) {
          // Text before a tool result is preamble ("Let me search…"), not the answer.
          const results = Array.isArray(cb.content) ? cb.content.filter((r) => r?.type === 'web_search_result') : [];
          return [{ type: 'content-reset' }, ...results.flatMap((r) => source(r.url, r.title, false))];
        }
        return [{ type: 'meta' }];
      }
      case 'content_block_delta':
        if (e.delta?.type === 'text_delta') return [{ type: 'content', text: e.delta.text }];
        if (e.delta?.type === 'thinking_delta') return [{ type: 'reasoning' }];
        if (e.delta?.type === 'citations_delta') return source(e.delta.citation?.url, e.delta.citation?.title, true);
        if (e.delta?.type === 'input_json_delta') return [{ type: 'activity' }]; // server tool input streaming
        return [{ type: 'meta' }]; // signature_delta etc.
      case 'message_delta': {
        if (e.delta?.stop_reason === 'pause_turn') {
          // The server-side search loop hit its iteration limit; resuming is not supported yet.
          return [{ type: 'error', message: `pause_turn (server-side search loop paused before finishing): ${rawStreamError(data)}` }];
        }
        const searches = e.usage?.server_tool_use?.web_search_requests;
        return [
          { type: 'usage', outputTokens: e.usage?.output_tokens ?? null, ...(Number.isFinite(searches) ? { webSearches: searches } : {}) },
          ...(e.delta?.stop_reason ? [{ type: 'finish', reason: e.delta.stop_reason }] : []),
        ];
      }
      case 'error': return [{ type: 'error', message: rawStreamError(data) }];
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
    return sortModels((r.models || []).map((m) => {
      const id = m.name.replace(/^models\//, '');
      return {
        id, label: m.displayName, contextWindow: m.inputTokenLimit, maxOutput: m.outputTokenLimit,
        ...classifyGeminiModel(id, m.supportedGenerationMethods || []),
        capabilities: { ...geminiCapabilities(id), ...(typeof m.thinking === 'boolean' ? { reasoning: m.thinking } : {}) },
      };
    }));
  },
  buildStreamRequest({ apiKey, model, system, messages, maxOutputTokens, reasoning, tools = [], jsonMode = true }) {
    // JSON mode can be off with tools (tools.json vendorOptions); the prompt and the strict
    // validator still require a single JSON object.
    const generationConfig = { maxOutputTokens, ...(jsonMode ? { responseMimeType: 'application/json' } : {}) };
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
        ...(tools.length ? { tools } : {}), // built-in tools from tools.json, e.g. Grounding with Google Search
      },
    };
  },
  parseEvent({ data }) {
    const e = safeJson(data);
    if (!e) return [{ type: 'meta' }];
    if (e.error) return [{ type: 'error', message: rawStreamError(data) }];
    const out = [];
    const cand = e.candidates?.[0];
    for (const part of cand?.content?.parts || []) {
      if (part.thought) out.push({ type: 'reasoning' });
      else if (typeof part.text === 'string' && part.text.length) out.push({ type: 'content', text: part.text });
    }
    const g = cand?.groundingMetadata;
    if (g) {
      for (const c of g.groundingChunks || []) out.push(...source(c.web?.uri, c.web?.title, true));
      if (Array.isArray(g.webSearchQueries) && g.webSearchQueries.length) out.push({ type: 'usage', webSearches: g.webSearchQueries.length });
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
