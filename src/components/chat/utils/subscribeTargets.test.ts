import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSubscribeTargets, sendSubscribeBatch } from './subscribeTargets';

const lastSeqFrom = (map: Record<string, number>) => (sessionId: string) => map[sessionId] ?? 0;

test('selected session leads the batch, followed by the other running sessions', () => {
  const targets = buildSubscribeTargets({
    selectedSessionId: 'viewed',
    runningSessionIds: ['background-a', 'background-b'],
    lastSeqFor: lastSeqFrom({ viewed: 7, 'background-a': 3, 'background-b': 0 }),
  });

  assert.deepEqual(targets, [
    { sessionId: 'viewed', lastSeq: 7 },
    { sessionId: 'background-a', lastSeq: 3 },
    { sessionId: 'background-b', lastSeq: 0 },
  ]);
});

test('the selected session is not duplicated when it is also in the running set', () => {
  const targets = buildSubscribeTargets({
    selectedSessionId: 'viewed',
    runningSessionIds: ['background-a', 'viewed'],
    lastSeqFor: lastSeqFrom({ viewed: 5, 'background-a': 2 }),
  });

  // The viewed session keeps its leading slot with its own lastSeq — the
  // running-set copy is de-duplicated away rather than appended a second time.
  assert.deepEqual(targets, [
    { sessionId: 'viewed', lastSeq: 5 },
    { sessionId: 'background-a', lastSeq: 2 },
  ]);
});

test('a reconnect with no viewed session still re-subscribes every running session', () => {
  const targets = buildSubscribeTargets({
    selectedSessionId: null,
    runningSessionIds: ['run-1', 'run-2'],
    lastSeqFor: lastSeqFrom({ 'run-1': 4, 'run-2': 9 }),
  });

  assert.deepEqual(targets, [
    { sessionId: 'run-1', lastSeq: 4 },
    { sessionId: 'run-2', lastSeq: 9 },
  ]);
});

test('only the selected session is sent when nothing runs in the background', () => {
  const targets = buildSubscribeTargets({
    selectedSessionId: 'viewed',
    runningSessionIds: [],
    lastSeqFor: lastSeqFrom({ viewed: 1 }),
  });

  assert.deepEqual(targets, [{ sessionId: 'viewed', lastSeq: 1 }]);
});

test('blank / whitespace / duplicate ids are skipped so no garbage target is sent', () => {
  const targets = buildSubscribeTargets({
    selectedSessionId: '   ',
    runningSessionIds: ['', '  ', 'real', 'real'],
    lastSeqFor: () => 0,
  });

  assert.deepEqual(targets, [{ sessionId: 'real', lastSeq: 0 }]);
});

test('accepts a Map keys() iterator as the running-session source', () => {
  // Mirrors the real call site, where the running set is a ReadonlyMap.
  const running = new Map<string, unknown>([
    ['viewed', {}],
    ['other', {}],
  ]);

  const targets = buildSubscribeTargets({
    selectedSessionId: 'viewed',
    runningSessionIds: running.keys(),
    lastSeqFor: lastSeqFrom({ viewed: 2, other: 6 }),
  });

  assert.deepEqual(targets, [
    { sessionId: 'viewed', lastSeq: 2 },
    { sessionId: 'other', lastSeq: 6 },
  ]);
});

// ---------------------------------------------------------------------------
// sendSubscribeBatch — the wiring the two React call sites share
// ---------------------------------------------------------------------------

function makeSendHarness() {
  const sent: Array<{ type: string; sessions: Array<{ sessionId: string; lastSeq: number }> }> = [];
  const marked: Array<{ sessionId: string; at: number }> = [];
  return {
    sent,
    marked,
    send: (message: { type: 'chat.subscribe'; sessions: Array<{ sessionId: string; lastSeq: number }> }) =>
      sent.push(message),
    markSubscribeSent: (sessionId: string, at: number) => marked.push({ sessionId, at }),
  };
}

test('sendSubscribeBatch sends one batch frame and stamps every target as sent', () => {
  const h = makeSendHarness();

  const targets = sendSubscribeBatch({
    selectedSessionId: 'viewed',
    runningSessionIds: ['background-a', 'viewed'],
    lastSeqFor: lastSeqFrom({ viewed: 5, 'background-a': 2 }),
    now: 1000,
    markSubscribeSent: h.markSubscribeSent,
    send: h.send,
  });

  // De-duped, viewed-first batch — sent exactly once, as a single chat.subscribe.
  assert.deepEqual(targets, [
    { sessionId: 'viewed', lastSeq: 5 },
    { sessionId: 'background-a', lastSeq: 2 },
  ]);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], { type: 'chat.subscribe', sessions: targets });
  // Every target's send time is stamped so the stale-idle-ack guard can work.
  assert.deepEqual(h.marked, [
    { sessionId: 'viewed', at: 1000 },
    { sessionId: 'background-a', at: 1000 },
  ]);
});

test('sendSubscribeBatch re-subscribes background runs even with no viewed session', () => {
  const h = makeSendHarness();

  // The reconnect-with-no-open-session case: still re-attach every running run.
  const targets = sendSubscribeBatch({
    selectedSessionId: null,
    runningSessionIds: ['run-1', 'run-2'],
    lastSeqFor: lastSeqFrom({ 'run-1': 3 }),
    now: 42,
    markSubscribeSent: h.markSubscribeSent,
    send: h.send,
  });

  assert.deepEqual(targets.map((t) => t.sessionId), ['run-1', 'run-2']);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0]?.sessions.map((s) => s.sessionId), ['run-1', 'run-2']);
});

test('sendSubscribeBatch is a no-op when there is nothing to subscribe', () => {
  const h = makeSendHarness();

  const targets = sendSubscribeBatch({
    selectedSessionId: null,
    runningSessionIds: [],
    lastSeqFor: () => 0,
    now: 1,
    markSubscribeSent: h.markSubscribeSent,
    send: h.send,
  });

  assert.deepEqual(targets, []);
  assert.equal(h.sent.length, 0, 'no frame is sent');
  assert.equal(h.marked.length, 0, 'nothing is stamped');
});
