import assert from 'node:assert/strict';
import test from 'node:test';

import { sendMessage } from './codex-send-message.js';

// A stand-in writer that records exactly what it received.
const fakeWriter = () => {
  const received = [];
  return { received, send(data) { received.push(data); } };
};

test('hands the object straight to ws.send (never stringified)', () => {
  const w = fakeWriter();
  const frame = { kind: 'text', role: 'assistant', content: 'hi', provider: 'codex' };
  sendMessage(w, frame);
  assert.equal(w.received.length, 1);
  // The whole point of #126: the frame must arrive as an OBJECT, so an
  // object-consuming writer (e.g. ResponseCollector) sees it. A regression to
  // JSON.stringify would make this a string.
  assert.equal(typeof w.received[0], 'object');
  assert.strictEqual(w.received[0], frame);
});

test('works regardless of legacy writer flags (no allow-list)', () => {
  // Neither SSE nor WS flag set — the shape that used to fall through to the
  // stringify branch (ResponseCollector). It must still get the object.
  const collectorLike = fakeWriter();
  sendMessage(collectorLike, { kind: 'status', text: 'token_budget', tokenBudget: { inputTokens: 5 } });
  assert.deepEqual(collectorLike.received[0], {
    kind: 'status',
    text: 'token_budget',
    tokenBudget: { inputTokens: 5 },
  });

  const sseLike = { isSSEStreamWriter: true, received: [], send(d) { this.received.push(d); } };
  sendMessage(sseLike, { kind: 'complete', success: true });
  assert.deepEqual(sseLike.received[0], { kind: 'complete', success: true });
});

test('no-ops safely when the writer has no send()', () => {
  assert.doesNotThrow(() => sendMessage(null, { kind: 'text' }));
  assert.doesNotThrow(() => sendMessage(undefined, { kind: 'text' }));
  assert.doesNotThrow(() => sendMessage({}, { kind: 'text' }));
});

test('swallows a throwing writer so a transport error cannot abort the run', () => {
  const boom = { send() { throw new Error('socket closed'); } };
  assert.doesNotThrow(() => sendMessage(boom, { kind: 'text', content: 'x' }));
});
