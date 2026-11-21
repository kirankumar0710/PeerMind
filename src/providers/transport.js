// §10 streaming transport with inactivity timeouts, shared by all provider adapters.
// Vendor-specific request/response shapes live in the adapters; this module is vendor-neutral.
import { DEFAULT_TIMEOUTS } from '../core/constants.js';

/** Provider error text (HTTP bodies, in-stream error events) is shown raw, up to this many characters. */
export const MAX_ERROR_CHARS = 2000;

export class ProviderError extends Error {
  /**
   * @param {'timeout'|'http'|'network'|'aborted'|'provider'} kind
   */
  constructor(kind, message, { status = null, partial = '', usage = null, headersReceived = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.partial = partial;
    this.usage = usage;
    this.headersReceived = headersReceived;
  }
}

/** Remove a secret from any text that might reach logs, UI or storage (FR-006). */
export function redact(text, secret) {
  let out = String(text ?? '');
  if (secret) out = out.split(secret).join('***');
  return out.replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1***').replace(/(AIza[0-9A-Za-z_-]{4})[0-9A-Za-z_-]+/g, '$1***');
}

/** Sources shown with an answer: the ones the model cited; if it cited none, the results it searched. */
export function pickSources(map, max = 20) {
  const all = [...map.values()];
  const cited = all.filter((s) => s.cited);
  return (cited.length ? cited : all).slice(0, max).map(({ url, title }) => ({ url, title }));
}

/** Incremental Server-Sent Events parser. Comment lines (": ping") are dropped. */
export function createSseParser() {
  let buffer = '';
  return function push(chunk) {
    buffer += chunk;
    const events = [];
    let idx;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) events.push({ event, data: data.join('\n') });
    }
    return events;
  };
}

/**
 * Run one streaming provider call.
 *
 * Timers (§10): headers within `streamingHeadersMs` of request start; then the first content token
 * within `firstContentMs` of inactivity (reasoning events reset it but are not content); after first
 * content, at most `inactivityMs` between activity events. Pings, keep-alives and metadata never count.
 *
 * @param {object} adapter      provider adapter (buildStreamRequest, parseEvent)
 * @param {object} req          adapter-neutral request
 * @param {object} opts         { apiKey, timeouts, signal, onActivity(kind) }
 * @returns {Promise<{text: string, usage: {inputTokens:number|null, outputTokens:number|null}, finish: string|null}>}
 */
export async function streamCall(adapter, req, { apiKey, timeouts = DEFAULT_TIMEOUTS, signal, onActivity, fetchImpl = fetch }) {
  const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const controller = new AbortController();
  const onAbort = () => controller.abort(new ProviderError('aborted', 'Stopped by user.'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const state = {
    text: '', usage: { inputTokens: null, outputTokens: null, webSearches: 0, images: 0 }, finish: null, gotContent: false, headers: false,
    sources: new Map(), // url -> { url, title, cited }
    images: new Map(), // provider item id -> base64 (the same image can be reported twice)
  };
  const live = (kind) => {
    arm(state.gotContent ? t.inactivityMs : t.firstContentMs, state.gotContent ? 'no stream activity' : 'waiting for first content');
    onActivity?.(kind);
  };
  let timer = null;
  let timeoutError = null;
  const arm = (ms, what) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timeoutError = new ProviderError('timeout', `Timed out: ${what} (${Math.round(ms / 1000)} s).`);
      controller.abort(timeoutError);
    }, ms);
  };

  const fail = (err) => {
    const e = err instanceof ProviderError ? err
      : controller.signal.reason instanceof ProviderError ? controller.signal.reason
      : new ProviderError('network', redact(err?.message || 'Network error', apiKey));
    e.partial = state.text;
    e.usage = state.usage;
    e.headersReceived = state.headers;
    return e;
  };

  try {
    const { url, headers, body } = adapter.buildStreamRequest({ ...req, apiKey });
    arm(t.streamingHeadersMs, 'waiting for response headers');
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (e) {
      throw fail(timeoutError || e);
    }
    state.headers = true;
    if (!res.ok) {
      clearTimeout(timer);
      const detail = await res.text().catch(() => '');
      throw new ProviderError('http', `HTTP ${res.status}: ${redact(detail.slice(0, MAX_ERROR_CHARS), apiKey)}`, { status: res.status, headersReceived: true });
    }
    arm(t.firstContentMs, 'waiting for first content');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parse = createSseParser();
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        throw fail(timeoutError || e);
      }
      if (chunk.done) break;
      for (const evt of parse(decoder.decode(chunk.value, { stream: true }))) {
        for (const out of adapter.parseEvent(evt)) {
          if (out.type === 'content') {
            state.text += out.text;
            state.gotContent = true;
            arm(t.inactivityMs, 'no stream activity');
            onActivity?.('content');
          } else if (out.type === 'reasoning') {
            // FR-093: reasoning content is never kept; it only proves liveness.
            live('reasoning');
          } else if (out.type === 'search') {
            state.usage.webSearches += 1; // provider-reported totals (usage.webSearches) override this count
            live('search');
          } else if (out.type === 'activity') {
            live('search'); // server-side tool progress
          } else if (out.type === 'content-reset') {
            // Text before a tool result was preamble ("Let me search…"); the answer comes after it.
            state.text = '';
            live('search');
          } else if (out.type === 'image') {
            if (out.base64 && !state.images.has(out.id ?? state.images.size)) state.images.set(out.id ?? state.images.size, out.base64);
            state.usage.images = state.images.size;
            live('image');
          } else if (out.type === 'source') {
            const prev = state.sources.get(out.url);
            state.sources.set(out.url, { url: out.url, title: out.title || prev?.title || out.url, cited: !!(out.cited || prev?.cited) });
          } else if (out.type === 'usage') {
            if (out.inputTokens != null) state.usage.inputTokens = out.inputTokens;
            if (out.outputTokens != null) state.usage.outputTokens = out.outputTokens;
            if (out.webSearches != null) state.usage.webSearches = out.webSearches;
          } else if (out.type === 'finish') {
            state.finish = out.reason;
          } else if (out.type === 'error') {
            throw new ProviderError('provider', redact(out.message, apiKey));
          }
          // 'meta' events (pings, keep-alives) deliberately do not touch the timers.
        }
      }
    }
    clearTimeout(timer);
    return { text: state.text, usage: state.usage, finish: state.finish, sources: pickSources(state.sources), images: [...state.images.values()] };
  } catch (e) {
    throw fail(e);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Non-streaming JSON GET/POST with one deadline from request start (§10). */
export async function jsonCall(url, { method = 'GET', headers = {}, body, apiKey, deadlineMs = DEFAULT_TIMEOUTS.nonStreamingMs, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const res = await fetchImpl(url, { method, headers, body: body && JSON.stringify(body), signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new ProviderError('http', `HTTP ${res.status}: ${redact(text.slice(0, MAX_ERROR_CHARS), apiKey)}`, { status: res.status });
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (controller.signal.aborted) throw new ProviderError('timeout', `Timed out after ${deadlineMs / 1000} s.`);
    throw new ProviderError('network', redact(e.message, apiKey));
  } finally {
    clearTimeout(timer);
  }
}
