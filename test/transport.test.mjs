import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamCall, createSseParser, redact } from '../src/providers/transport.js';
import { ADAPTERS } from '../src/providers/adapters.js';

// A fake adapter: data "C:x" = content x, "R" = reasoning, "P" = meta/ping.
const fake = {
  buildStreamRequest: () => ({ url: 'https://example.test', headers: {}, body: {} }),
  parseEvent: ({ data }) => {
    if (data.startsWith('C:')) return [{ type: 'content', text: data.slice(2) }];
    if (data === 'R') return [{ type: 'reasoning' }];
    if (data === 'U') return [{ type: 'usage', inputTokens: 7, outputTokens: 3 }];
    return [{ type: 'meta' }];
  },
};

/** fetch that streams `script` steps: [delayMs, data] */
function fakeFetch(script, { headerDelay = 0, status = 200 } = {}) {
  return (url, { signal }) => new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    setTimeout(() => {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        async start(ctrl) {
          signal.addEventListener('abort', () => ctrl.error(signal.reason), { once: true });
          for (const [delay, data] of script) {
            await new Promise((r) => setTimeout(r, delay));
            if (signal.aborted) return;
            ctrl.enqueue(enc.encode(`data: ${data}\n\n`));
          }
          ctrl.close();
        },
      });
      resolve(new Response(status === 200 ? body : 'bad key sk-abcdefghijklmnop', { status }));
    }, headerDelay);
  });
}

const T = { streamingHeadersMs: 50, firstContentMs: 80, inactivityMs: 40, nonStreamingMs: 300 };

test('happy path collects content and usage', async () => {
  const r = await streamCall(fake, {}, { timeouts: T, fetchImpl: fakeFetch([[5, 'C:{"a"'], [5, 'C::1}'], [5, 'U']]) });
  assert.equal(r.text, '{"a":1}');
  assert.deepEqual(r.usage, { inputTokens: 7, outputTokens: 3 });
});

test('header timeout (30 s default, scaled)', async () => {
  await assert.rejects(streamCall(fake, {}, { timeouts: T, fetchImpl: fakeFetch([], { headerDelay: 100 }) }), (e) => e.kind === 'timeout');
});

test('reasoning events keep a slow first response alive beyond the first-content limit (PoC 1)', async () => {
  const script = [[50, 'R'], [50, 'R'], [50, 'R'], [10, 'C:ok']]; // 160 ms > 80 ms first-content limit
  const r = await streamCall(fake, {}, { timeouts: T, fetchImpl: fakeFetch(script) });
  assert.equal(r.text, 'ok');
});

test('pings alone do not keep the stream alive (PoC 2, FR-037)', async () => {
  const script = [[30, 'P'], [30, 'P'], [30, 'P'], [30, 'C:late']];
  await assert.rejects(streamCall(fake, {}, { timeouts: T, fetchImpl: fakeFetch(script) }), (e) => e.kind === 'timeout');
});

test('inactivity after first content fails with partial output kept (FR-035)', async () => {
  const script = [[5, 'C:part'], [100, 'C:never']];
  await assert.rejects(streamCall(fake, {}, { timeouts: T, fetchImpl: fakeFetch(script) }), (e) => e.kind === 'timeout' && e.partial === 'part');
});

test('user abort is reported as aborted with partial', async () => {
  const ctl = new AbortController();
  const p = streamCall(fake, {}, { timeouts: T, signal: ctl.signal, fetchImpl: fakeFetch([[5, 'C:a'], [30, 'C:b']]) });
  setTimeout(() => ctl.abort(), 15);
  await assert.rejects(p, (e) => e.kind === 'aborted' && e.partial === 'a');
});

test('HTTP errors never echo the API key (FR-006)', async () => {
  await assert.rejects(
    streamCall(fake, {}, { apiKey: 'sk-abcdefghijklmnop', timeouts: T, fetchImpl: fakeFetch([], { status: 401 }) }),
    (e) => e.kind === 'http' && !e.message.includes('sk-abcdefghijklmnop'),
  );
  assert.equal(redact('key=SECRET123 end', 'SECRET123'), 'key=*** end');
});

test('SSE parser handles split chunks, comments and multi-line data', () => {
  const push = createSseParser();
  assert.deepEqual(push(': ping\n\nevent: x\nda'), []);
  assert.deepEqual(push('ta: 1\ndata: 2\n\n'), [{ event: 'x', data: '1\n2' }]);
});

test('adapters map reasoning to liveness-only events with no text (FR-093)', () => {
  const a = ADAPTERS.anthropic.parseEvent({ event: 'content_block_delta', data: JSON.stringify({ delta: { type: 'thinking_delta', thinking: 'secret' } }) });
  assert.deepEqual(a, [{ type: 'reasoning' }]);
  const o = ADAPTERS.openai.parseEvent({ event: 'message', data: JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'secret' }) });
  assert.deepEqual(o, [{ type: 'reasoning' }]);
  const g = ADAPTERS.google.parseEvent({ event: 'message', data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'secret', thought: true }, { text: '{}' }] } }] }) });
  assert.deepEqual(g, [{ type: 'reasoning' }, { type: 'content', text: '{}' }]);
  assert.deepEqual(ADAPTERS.anthropic.parseEvent({ event: 'ping', data: '{}' }), [{ type: 'meta' }]);
});
