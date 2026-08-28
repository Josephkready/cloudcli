import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeMerged,
  createEmptySlot,
  dedupeAdjacentAssistantEchoes,
  findServerTurnRangeByOrdinal,
  getUserTurnOrdinalBefore,
  hasServerEchoForLocalUser,
  isAssistantTextEchoedInSameTurnOnServer,
  isSameServerTranscript,
  mergeRefreshedTail,
  pruneRealtimeSupersededByServer,
  recomputeMergedIfNeeded,
  userTextFingerprint,
} from './useSessionStore.pure';
import type { NormalizedMessage } from './useSessionStore.pure';

const SESSION_ID = 'session-1';

/** Minutes past a fixed base instant, as an ISO timestamp. */
const at = (minutes: number): string =>
  new Date(Date.UTC(2026, 6, 21, 10, 0, 0) + minutes * 60_000).toISOString();

const message = (
  overrides: Partial<NormalizedMessage> & { id: string },
): NormalizedMessage => ({
  sessionId: SESSION_ID,
  timestamp: at(0),
  provider: 'claude',
  kind: 'text',
  ...overrides,
});

const user = (id: string, content: string, minutes: number): NormalizedMessage =>
  message({ id, kind: 'text', role: 'user', content, timestamp: at(minutes) });

const assistant = (id: string, content: string, minutes: number): NormalizedMessage =>
  message({ id, kind: 'text', role: 'assistant', content, timestamp: at(minutes) });

const streaming = (content: string, minutes: number): NormalizedMessage =>
  message({
    id: `__streaming_${SESSION_ID}`,
    kind: 'stream_delta',
    content,
    timestamp: at(minutes),
  });

const ids = (messages: NormalizedMessage[]): string[] => messages.map((m) => m.id);

describe('userTextFingerprint', () => {
  it('returns the trimmed text of a user text row', () => {
    assert.equal(userTextFingerprint(user('u1', '  hello  ', 0)), 'hello');
  });

  it('ignores assistant rows, non-text kinds and blank content', () => {
    assert.equal(userTextFingerprint(assistant('a1', 'hello', 0)), null);
    assert.equal(
      userTextFingerprint(message({ id: 't1', kind: 'tool_use', role: 'user', content: 'hello' })),
      null,
    );
    assert.equal(userTextFingerprint(user('u2', '   ', 0)), null);
  });
});

describe('hasServerEchoForLocalUser', () => {
  it('matches the same prompt persisted a moment later', () => {
    const local = user('local_1', 'ship it', 0);
    const server = [user('srv_1', 'ship it', 1)];
    assert.equal(hasServerEchoForLocalUser(local, server), true);
  });

  it('ignores whitespace differences around the prompt', () => {
    const local = user('local_1', '  ship it\n', 0);
    assert.equal(hasServerEchoForLocalUser(local, [user('srv_1', 'ship it', 0)]), true);
  });

  it('does not match the same prompt sent again much later', () => {
    // Repeating a prompt an hour later is a genuinely new turn, not an echo.
    const local = user('local_1', 'ship it', 0);
    const server = [user('srv_1', 'ship it', 60)];
    assert.equal(hasServerEchoForLocalUser(local, server), false);
  });

  it('tolerates the server clock running slightly behind the client', () => {
    const local = user('local_1', 'ship it', 1);
    // 9s behind is within the skew allowance; 30s behind is not.
    const slightlyBehind = [{ ...user('srv_1', 'ship it', 1), timestamp: at(1 - 9 / 60) }];
    const wayBehind = [{ ...user('srv_2', 'ship it', 1), timestamp: at(1 - 30 / 60) }];
    assert.equal(hasServerEchoForLocalUser(local, slightlyBehind), true);
    assert.equal(hasServerEchoForLocalUser(local, wayBehind), false);
  });

  it('never matches a different prompt, an assistant row, or an undated row', () => {
    const local = user('local_1', 'ship it', 0);
    assert.equal(hasServerEchoForLocalUser(local, [user('srv_1', 'ship it later', 0)]), false);
    assert.equal(hasServerEchoForLocalUser(local, [assistant('srv_2', 'ship it', 0)]), false);
    assert.equal(
      hasServerEchoForLocalUser({ ...local, timestamp: 'not-a-date' }, [user('srv_3', 'ship it', 0)]),
      false,
    );
  });
});

describe('findServerTurnRangeByOrdinal', () => {
  const server = [
    user('u0', 'first', 0),
    assistant('a0', 'one', 1),
    user('u1', 'second', 2),
    message({ id: 'tool', kind: 'tool_use', toolId: 'tool-1', timestamp: at(3) }),
    assistant('a1', 'two', 4),
  ];

  it('spans from a user row up to the next user row', () => {
    assert.deepEqual(findServerTurnRangeByOrdinal(server, 0), { start: 0, end: 2 });
  });

  it('runs the last turn to the end of the transcript', () => {
    assert.deepEqual(findServerTurnRangeByOrdinal(server, 1), { start: 2, end: 5 });
  });

  it('returns null when the transcript has no such turn', () => {
    assert.equal(findServerTurnRangeByOrdinal(server, 2), null);
    assert.equal(findServerTurnRangeByOrdinal([], 0), null);
  });
});

describe('getUserTurnOrdinalBefore', () => {
  it('resolves a realtime assistant row to the turn it belongs to', () => {
    const server = [user('u0', 'first', 0), assistant('a0', 'one', 1), user('u1', 'second', 2)];
    const realtime = [assistant('rt', 'two', 3)];
    assert.equal(getUserTurnOrdinalBefore(realtime[0], server, realtime), 1);
  });

  it('counts a not-yet-persisted realtime prompt as its own turn', () => {
    const server = [user('u0', 'first', 0), assistant('a0', 'one', 1)];
    const realtime = [user('local_1', 'second', 2), assistant('rt', 'two', 3)];
    assert.equal(getUserTurnOrdinalBefore(realtime[1], server, realtime), 1);
  });

  it('does not double-count a prompt that exists both locally and on the server', () => {
    // Regression: the optimistic `local_*` row and its persisted copy are one
    // turn. Counting both pushed the ordinal past the end of the server
    // transcript, so the same-turn echo check silently gave up and the
    // assistant reply was rendered twice.
    const server = [
      user('u0', 'first', 0),
      assistant('a0', 'one', 1),
      user('u1', 'second', 2),
      assistant('a1', 'two', 3),
    ];
    const realtime = [user('local_1', 'second', 2), assistant('rt', 'two', 3)];
    assert.equal(getUserTurnOrdinalBefore(realtime[1], server, realtime), 1);
  });

  it('does not double-count a realtime row already present on the server by id', () => {
    const server = [user('u0', 'first', 0), user('u1', 'second', 2), assistant('a1', 'two', 3)];
    const realtime = [server[1], assistant('rt', 'two', 3)];
    assert.equal(getUserTurnOrdinalBefore(realtime[1], server, realtime), 1);
  });

  it('only collapses optimistic (local_) prompts against a server echo, not other rows', () => {
    // The echo collapse is scoped to `local_*` rows, matching computeMerged /
    // pruneRealtimeSupersededByServer. A non-optimistic realtime user row is
    // rendered as its own bubble there, so it must also count as its own turn
    // here — even if its text happens to match a server row. Three user rows
    // (u0, srv_dupe, rt_dupe) precede the reply, so its ordinal is 2. Were the
    // `local_*` guard dropped, rt_dupe would be collapsed and the ordinal would
    // wrongly fall to 1.
    const server = [user('u0', 'first', 0), user('srv_dupe', 'second', 2)];
    const realtime = [user('rt_dupe', 'second', 2), assistant('rt', 'reply', 3)];
    assert.equal(getUserTurnOrdinalBefore(realtime[1], server, realtime), 2);
  });
});

describe('isAssistantTextEchoedInSameTurnOnServer', () => {
  const server = [
    user('u0', 'first', 0),
    assistant('a0', 'one', 1),
    user('u1', 'second', 2),
    assistant('a1', 'two', 3),
  ];

  it('recognises the persisted copy of the reply in the same turn', () => {
    const realtime = [assistant('rt', 'two', 3)];
    assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], server, realtime), true);
  });

  it('does not treat an identical reply from an earlier turn as an echo', () => {
    // "one" is on disk, but under turn 0 — the live row belongs to turn 1.
    const realtime = [assistant('rt', 'one', 3)];
    assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], server, realtime), false);
  });

  it('matches the right turn when two turns share the same reply text', () => {
    const repeated = [
      user('u0', 'ping', 0),
      assistant('a0', 'pong', 1),
      user('u1', 'ping', 2),
      assistant('a1', 'pong', 3),
    ];
    const realtime = [assistant('rt', 'pong', 3)];
    assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], repeated, realtime), true);
  });

  it('keeps a reply the server has not written yet', () => {
    const pending = [user('u0', 'first', 0), user('u1', 'second', 2)];
    const realtime = [assistant('rt', 'two', 3)];
    assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], pending, realtime), false);
  });

  it('never matches on empty text', () => {
    const realtime = [assistant('rt', '   ', 3)];
    assert.equal(
      isAssistantTextEchoedInSameTurnOnServer(realtime[0], [...server, assistant('a2', '', 3)], realtime),
      false,
    );
  });
});

describe('dedupeAdjacentAssistantEchoes', () => {
  it('keeps the first of two identical adjacent assistant bubbles', () => {
    const merged = [
      user('u0', 'hi', 0),
      assistant('server_a', 'hello', 1),
      assistant('local_a', 'hello', 1),
    ];
    assert.deepEqual(ids(dedupeAdjacentAssistantEchoes(merged)), ['u0', 'server_a']);
  });

  it('ignores leading/trailing whitespace when comparing bubbles', () => {
    const merged = [assistant('a0', 'hello', 0), assistant('a1', '  hello\n', 1)];
    assert.deepEqual(ids(dedupeAdjacentAssistantEchoes(merged)), ['a0']);
  });

  it('promotes a stream placeholder to the finalized text row', () => {
    const merged = [streaming('hello', 0), assistant('final', 'hello', 1)];
    const out = dedupeAdjacentAssistantEchoes(merged);
    assert.deepEqual(ids(out), ['final']);
    assert.equal(out[0].kind, 'text');
  });

  it('keeps a stream placeholder whose text diverges from the next row', () => {
    const merged = [streaming('hell', 0), assistant('final', 'hello', 1)];
    assert.deepEqual(ids(dedupeAdjacentAssistantEchoes(merged)), [
      `__streaming_${SESSION_ID}`,
      'final',
    ]);
  });

  it('keeps identical replies that are separated by another turn', () => {
    const merged = [
      assistant('a0', 'sure', 0),
      user('u1', 'again', 1),
      assistant('a1', 'sure', 2),
    ];
    assert.deepEqual(ids(dedupeAdjacentAssistantEchoes(merged)), ['a0', 'u1', 'a1']);
  });

  it('never collapses repeated user prompts', () => {
    const merged = [user('u0', 'again', 0), user('u1', 'again', 1)];
    assert.deepEqual(ids(dedupeAdjacentAssistantEchoes(merged)), ['u0', 'u1']);
  });

  it('never collapses blank assistant rows onto each other', () => {
    const merged = [assistant('a0', '', 0), assistant('a1', '  ', 1)];
    assert.deepEqual(ids(dedupeAdjacentAssistantEchoes(merged)), ['a0', 'a1']);
  });

  it('is idempotent', () => {
    const merged = [
      user('u0', 'hi', 0),
      streaming('hello', 1),
      assistant('final', 'hello', 1),
      assistant('dupe', 'hello', 1),
    ];
    const once = dedupeAdjacentAssistantEchoes(merged);
    assert.deepEqual(ids(dedupeAdjacentAssistantEchoes(once)), ids(once));
    assert.deepEqual(ids(once), ['u0', 'final']);
  });
});

describe('pruneRealtimeSupersededByServer', () => {
  it('returns the same array when there is nothing live', () => {
    const realtime: NormalizedMessage[] = [];
    assert.equal(pruneRealtimeSupersededByServer([user('u0', 'hi', 0)], realtime), realtime);
  });

  it('drops live rows the transcript now owns by id', () => {
    const shared = assistant('a0', 'hello', 1);
    const kept = message({ id: 'status_1', kind: 'status', timestamp: at(2) });
    assert.deepEqual(
      ids(pruneRealtimeSupersededByServer([shared], [shared, kept])),
      ['status_1'],
    );
  });

  it('drops the optimistic prompt once the server has persisted it', () => {
    const server = [user('u0', 'ship it', 1)];
    const realtime = [user('local_1', 'ship it', 0)];
    assert.deepEqual(ids(pruneRealtimeSupersededByServer(server, realtime)), []);
  });

  it('keeps the optimistic prompt while the transcript still lags', () => {
    const server = [user('u0', 'something else', 1)];
    const realtime = [user('local_1', 'ship it', 0)];
    assert.deepEqual(ids(pruneRealtimeSupersededByServer(server, realtime)), ['local_1']);
  });

  it('drops the whole optimistic turn once the transcript has caught up', () => {
    // The end state of a send: prompt + reply both on disk, so nothing live
    // should survive to be rendered a second time.
    const server = [
      user('u0', 'first', 0),
      assistant('a0', 'one', 1),
      user('u1', 'second', 2),
      assistant('a1', 'two', 3),
    ];
    const realtime = [user('local_1', 'second', 2), assistant('rt', 'two', 3)];
    assert.deepEqual(ids(pruneRealtimeSupersededByServer(server, realtime)), []);
  });

  it('keeps a finalized reply the transcript has not written yet', () => {
    const server = [user('u0', 'first', 0), user('u1', 'second', 2)];
    const realtime = [assistant('rt', 'two', 3)];
    assert.deepEqual(ids(pruneRealtimeSupersededByServer(server, realtime)), ['rt']);
  });

  it('drops the stream placeholder once its text is on disk for that turn', () => {
    const server = [user('u0', 'first', 0), assistant('a0', 'one', 1)];
    const realtime = [streaming('one', 1)];
    assert.deepEqual(ids(pruneRealtimeSupersededByServer(server, realtime)), []);
  });

  it('keeps a stream placeholder that is still ahead of the transcript', () => {
    const server = [user('u0', 'first', 0)];
    const realtime = [streaming('one', 1)];
    assert.deepEqual(ids(pruneRealtimeSupersededByServer(server, realtime)), [
      `__streaming_${SESSION_ID}`,
    ]);
  });

  it('drops a tool call the transcript already records under the same tool id', () => {
    const server = [message({ id: 'srv_tool', kind: 'tool_use', toolId: 'tool-1', timestamp: at(1) })];
    const realtime = [message({ id: 'rt_tool', kind: 'tool_use', toolId: 'tool-1', timestamp: at(1) })];
    assert.deepEqual(ids(pruneRealtimeSupersededByServer(server, realtime)), []);
  });

  it('keeps a tool call the transcript does not have', () => {
    const server = [message({ id: 'srv_tool', kind: 'tool_use', toolId: 'tool-1', timestamp: at(1) })];
    const realtime = [message({ id: 'rt_tool', kind: 'tool_use', toolId: 'tool-2', timestamp: at(1) })];
    assert.deepEqual(ids(pruneRealtimeSupersededByServer(server, realtime)), ['rt_tool']);
  });

  it('keeps live rows that have no transcript equivalent at all', () => {
    const server = [user('u0', 'first', 0)];
    const realtime = [
      message({ id: 'perm_1', kind: 'permission_request', timestamp: at(1) }),
      message({ id: 'res_1', kind: 'tool_result', timestamp: at(2) }),
    ];
    assert.deepEqual(ids(pruneRealtimeSupersededByServer(server, realtime)), ['perm_1', 'res_1']);
  });
});

describe('computeMerged', () => {
  it('returns the deduped transcript when nothing is live', () => {
    const server = [user('u0', 'hi', 0), assistant('a0', 'hello', 1), assistant('a1', 'hello', 1)];
    assert.deepEqual(ids(computeMerged(server, [])), ['u0', 'a0']);
  });

  it('returns the deduped live rows when the transcript is empty', () => {
    const realtime = [user('local_1', 'hi', 0), streaming('hello', 1), assistant('final', 'hello', 1)];
    assert.deepEqual(ids(computeMerged([], realtime)), ['local_1', 'final']);
  });

  it('never renders the same id twice', () => {
    const shared = assistant('a0', 'hello', 1);
    const merged = computeMerged([user('u0', 'hi', 0), shared], [shared]);
    assert.deepEqual(ids(merged), ['u0', 'a0']);
  });

  it('drops the optimistic prompt once the transcript carries it', () => {
    const server = [user('u0', 'ship it', 1), assistant('a0', 'on it', 2)];
    const realtime = [user('local_1', 'ship it', 0)];
    assert.deepEqual(ids(computeMerged(server, realtime)), ['u0', 'a0']);
  });

  it('keeps a repeated prompt sent long after the first one', () => {
    const server = [user('u0', 'ship it', 0)];
    const realtime = [user('local_1', 'ship it', 90)];
    assert.deepEqual(ids(computeMerged(server, realtime)), ['u0', 'local_1']);
  });

  it('interleaves live rows into their own turn instead of appending them', () => {
    // A live row timestamped mid-conversation must not pile up at the bottom
    // after a refresh brings back newer transcript rows.
    const server = [user('u0', 'first', 0), assistant('a0', 'one', 1), user('u1', 'second', 4)];
    const realtime = [message({ id: 'rt_tool', kind: 'tool_use', toolId: 't', timestamp: at(2) })];
    assert.deepEqual(ids(computeMerged(server, realtime)), ['u0', 'a0', 'rt_tool', 'u1']);
  });

  it('keeps the transcript order for rows that share a timestamp', () => {
    const server = [user('u0', 'first', 0), assistant('a0', 'one', 0)];
    const realtime = [message({ id: 'rt', kind: 'status', timestamp: at(0) })];
    assert.deepEqual(ids(computeMerged(server, realtime)), ['u0', 'a0', 'rt']);
  });

  it('collapses the finalized stream row onto its persisted copy', () => {
    // The finalizeStreaming race: a synthetic assistant row with a client-made
    // id sits next to the same reply just written to disk.
    const server = [user('u0', 'hi', 0), assistant('srv_a', 'hello there', 1)];
    const realtime = [
      user('local_1', 'hi', 0),
      message({ id: 'text_123', kind: 'text', role: 'assistant', content: 'hello there', timestamp: at(1) }),
    ];
    assert.deepEqual(ids(computeMerged(server, realtime)), ['u0', 'srv_a']);
  });

  it('is idempotent — re-merging its own output changes nothing', () => {
    const server = [user('u0', 'hi', 0), assistant('srv_a', 'hello there', 1)];
    const realtime = [
      user('local_1', 'hi', 0),
      message({ id: 'text_123', kind: 'text', role: 'assistant', content: 'hello there', timestamp: at(1) }),
    ];
    const once = computeMerged(server, realtime);
    assert.deepEqual(ids(computeMerged(once, [])), ids(once));
    assert.deepEqual(ids(computeMerged(once, realtime)), ids(once));
  });

  it('sorts a row with an unparseable timestamp to the front instead of throwing', () => {
    // Date.parse fails → readMessageTime returns null → the comparator treats it
    // as time 0, so it sorts ahead of dated rows rather than producing NaN.
    const undated = message({ id: 'undated', kind: 'status', timestamp: 'not-a-date' });
    const server = [user('u0', 'first', 5), assistant('a0', 'one', 6)];
    const merged = computeMerged(server, [undated]);
    assert.equal(merged[0].id, 'undated');
    assert.deepEqual(ids(merged), ['undated', 'u0', 'a0']);
  });

  it('preserves every distinct bubble — no drops', () => {
    const server = [
      user('u0', 'first', 0),
      assistant('a0', 'one', 1),
      user('u1', 'second', 2),
    ];
    const realtime = [
      message({ id: 'rt_tool', kind: 'tool_use', toolId: 't', timestamp: at(3) }),
      message({ id: 'rt_res', kind: 'tool_result', timestamp: at(4) }),
      assistant('rt_a', 'two', 5),
    ];
    assert.deepEqual(ids(computeMerged(server, realtime)), [
      'u0', 'a0', 'u1', 'rt_tool', 'rt_res', 'rt_a',
    ]);
  });
});

describe('recomputeMergedIfNeeded', () => {
  it('recomputes when the transcript array changes', () => {
    const slot = createEmptySlot();
    slot.serverMessages = [user('u0', 'hi', 0)];
    assert.equal(recomputeMergedIfNeeded(slot), true);
    assert.deepEqual(ids(slot.merged), ['u0']);
  });

  it('skips the recompute when neither input array changed identity', () => {
    const slot = createEmptySlot();
    slot.serverMessages = [user('u0', 'hi', 0)];
    recomputeMergedIfNeeded(slot);
    const cached = slot.merged;

    assert.equal(recomputeMergedIfNeeded(slot), false);
    assert.equal(slot.merged, cached);
  });

  it('recomputes when only the live array changes', () => {
    const slot = createEmptySlot();
    slot.serverMessages = [user('u0', 'hi', 0)];
    recomputeMergedIfNeeded(slot);

    slot.realtimeMessages = [streaming('hello', 1)];
    assert.equal(recomputeMergedIfNeeded(slot), true);
    assert.deepEqual(ids(slot.merged), ['u0', `__streaming_${SESSION_ID}`]);
  });

  it('starts every slot idle and empty', () => {
    const slot = createEmptySlot();
    assert.equal(slot.status, 'idle');
    assert.deepEqual(slot.merged, []);
    assert.equal(slot.hasMore, false);
    assert.equal(slot._fetchSeq, 0);
    assert.equal(slot._appliedFetchSeq, 0);
  });

  it('does not share mutable arrays between slots', () => {
    const first = createEmptySlot();
    const second = createEmptySlot();
    first.serverMessages = [user('u0', 'hi', 0)];
    recomputeMergedIfNeeded(first);
    assert.deepEqual(second.serverMessages, []);
    assert.deepEqual(second.merged, []);
  });
});

describe('mergeRefreshedTail', () => {
  it('splices an overlapping page onto the loaded rows without losing older ones', () => {
    const loaded = [
      user('u1', 'first', 0),
      assistant('a1', 'first reply', 1),
      user('u2', 'second', 2),
      assistant('a2', 'second reply', 3),
    ];
    // What the server returns for `?limit=3`: the newest three, where the two
    // oldest of them are rows we already hold.
    const page = [
      user('u2', 'second', 2),
      assistant('a2', 'second reply', 3),
      assistant('a3', 'third reply', 4),
    ];

    assert.deepEqual(
      mergeRefreshedTail(loaded, page).map((m) => m.id),
      ['u1', 'a1', 'u2', 'a2', 'a3'],
    );
  });

  it('prefers the page for rows both sides hold, since the server is authoritative', () => {
    const loaded = [assistant('a1', 'partial', 0)];
    const page = [assistant('a1', 'complete text as persisted', 0)];

    assert.deepEqual(mergeRefreshedTail(loaded, page), page);
  });

  it('appends a page that is entirely newer than everything loaded', () => {
    const loaded = [user('u1', 'first', 0)];
    const page = [assistant('a9', 'much later', 30)];

    assert.deepEqual(
      mergeRefreshedTail(loaded, page).map((m) => m.id),
      ['u1', 'a9'],
    );
  });

  it('leaves the loaded rows untouched for an empty page', () => {
    const loaded = [user('u1', 'first', 0)];

    // Identity, not just equality: `recomputeMergedIfNeeded` skips work by
    // comparing array references, so returning a fresh copy here would make
    // every empty refresh re-derive the merged transcript for nothing.
    assert.equal(mergeRefreshedTail(loaded, []), loaded);
  });

  it('returns the page when nothing is loaded yet', () => {
    const page = [user('u1', 'first', 0)];

    assert.equal(mergeRefreshedTail([], page), page);
  });

  it('is idempotent when the same page is applied twice', () => {
    const loaded = [user('u1', 'first', 0), assistant('a1', 'reply', 1)];
    const page = [assistant('a1', 'reply', 1), assistant('a2', 'later', 2)];

    const once = mergeRefreshedTail(loaded, page);
    assert.deepEqual(mergeRefreshedTail(once, page).map((m) => m.id), once.map((m) => m.id));
  });
});

describe('isSameServerTranscript', () => {
  it('recognises a re-fetch of an unchanged transcript', () => {
    const loaded = [user('u1', 'hello', 0), assistant('a1', 'hi', 1)];
    // A fresh array of fresh objects, as JSON.parse hands back every time.
    const refetched = loaded.map((entry) => ({ ...entry }));

    assert.equal(isSameServerTranscript(loaded, refetched), true);
  });

  it('notices an appended message', () => {
    const loaded = [user('u1', 'hello', 0)];

    assert.equal(isSameServerTranscript(loaded, [...loaded, assistant('a1', 'hi', 1)]), false);
  });

  it('notices edited content at the same id', () => {
    const loaded = [assistant('a1', 'partial', 0)];

    assert.equal(isSameServerTranscript(loaded, [assistant('a1', 'partial and then some', 0)]), false);
  });

  it('notices a tool result that has since arrived for a row already loaded', () => {
    // The case worth pinning: a `tool_use` row is written before its result
    // exists, so two reads of the same append-only file can differ in nothing
    // but this field. Treating them as equal would freeze the pending state.
    const pending = message({ id: 't1', kind: 'tool_use', toolId: 'toolu_1', content: '' });
    const resolved = {
      ...pending,
      toolResult: { content: 'done', isError: false },
    };

    assert.equal(isSameServerTranscript([pending], [resolved]), false);
    assert.equal(isSameServerTranscript([resolved], [resolved]), true);
  });

  it('notices an error flag flipping on an otherwise identical row', () => {
    const ok = message({ id: 't1', kind: 'tool_result', toolId: 'toolu_1', content: 'out', isError: false });
    const failed = { ...ok, isError: true };

    assert.equal(isSameServerTranscript([ok], [failed]), false);
  });
});

/**
 * The known blind spot, pinned deliberately.
 *
 * `isSameServerTranscript` compares the fields the transcript renders and that
 * two reads of an append-only file can legitimately differ in. It does not
 * compare everything on a `NormalizedMessage`, and it should not — a deep
 * comparison would cost more than the re-render it saves. But that makes the
 * chosen field list load-bearing: if normalization ever starts varying a field
 * outside it across reads, the store keeps the stale array and the UI silently
 * stops updating.
 *
 * This test documents the boundary rather than asserting it is correct, so that
 * adding a field to `NormalizedMessage` surfaces the decision instead of
 * quietly inheriting the gap.
 */
describe('isSameServerTranscript — deliberately uncompared fields', () => {
  it('does not notice a change confined to fields outside the compared set', () => {
    const before = message({ id: 't1', kind: 'tool_use', toolId: 'toolu_1', toolInput: { path: 'a.ts' } });
    const after = { ...before, toolInput: { path: 'b.ts' } };

    // Accepted today because `toolInput` is written once when the row is created
    // and never revised by a later read. If that ever stops being true, this
    // assertion flips and the field belongs in the comparison.
    assert.equal(isSameServerTranscript([before], [after]), true);
  });
});
