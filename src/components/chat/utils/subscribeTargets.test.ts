import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSubscribeTargets } from './subscribeTargets';

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
