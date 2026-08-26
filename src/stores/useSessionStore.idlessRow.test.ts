import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeMerged,
  createEmptySlot,
  getUserTurnOrdinalBefore,
  hasUsableMessageId,
  pruneRealtimeSupersededByServer,
  recomputeMergedIfNeeded,
} from './useSessionStore.pure';
import type { NormalizedMessage } from './useSessionStore.pure';

/**
 * #450 / #448 / #389 — one malformed row must not be able to kill a session.
 *
 * The merge path dereferenced `message.id` without a guard
 * (`message.id.startsWith('local_')`). Every genuine transcript row has an id,
 * but the chat websocket also carries hand-rolled gateway frames that do not —
 * `chat_resumed`, emitted on one click of the interrupted-run banner, being the
 * live example. When such a frame reached the store the merge threw, and
 * because `appendRealtime` assigns `slot.realtimeMessages` BEFORE recomputing,
 * the bad row stayed in the slot: `merged` froze, and every later append or
 * refresh for that session threw on the same row. The chat was dead until the
 * app was reopened.
 *
 * The throw also travelled upward. `handleSubmit` calls into this store to
 * render its optimistic bubble, so a poisoned session made the send look like
 * it had not happened at all — while the server was already running it.
 */

const SESSION_ID = 'session-1';

const at = (minutes: number): string =>
  new Date(Date.UTC(2026, 6, 21, 10, 0, 0) + minutes * 60_000).toISOString();

const user = (id: string, content: string, minutes: number): NormalizedMessage => ({
  id,
  sessionId: SESSION_ID,
  timestamp: at(minutes),
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content,
});

const assistant = (id: string, content: string, minutes: number): NormalizedMessage => ({
  id,
  sessionId: SESSION_ID,
  timestamp: at(minutes),
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content,
});

/**
 * A `chat_resumed` frame exactly as the gateway emits it — no `id`, no
 * `provider`, no `kind` the store knows — cast the way the realtime handler
 * used to cast it.
 */
const chatResumedFrame = (): NormalizedMessage => ({
  kind: 'chat_resumed',
  sessionId: SESSION_ID,
  resumed: 1,
  timestamp: at(2),
} as unknown as NormalizedMessage);

const ids = (messages: NormalizedMessage[]): string[] => messages.map((m) => m.id);

describe('hasUsableMessageId', () => {
  it('accepts a real transcript row', () => {
    assert.equal(hasUsableMessageId(user('u1', 'hi', 0)), true);
  });

  it('rejects the shapes that reach the store off the wire', () => {
    assert.equal(hasUsableMessageId(chatResumedFrame()), false);
    assert.equal(hasUsableMessageId({ id: '' } as NormalizedMessage), false);
    assert.equal(hasUsableMessageId({ id: 42 } as unknown as NormalizedMessage), false);
    assert.equal(hasUsableMessageId(null), false);
    assert.equal(hasUsableMessageId(undefined), false);
  });
});

describe('computeMerged with an id-less realtime row (#450)', () => {
  it('does not throw', () => {
    const server = [user('u1', 'hello', 0), assistant('a1', 'hi there', 1)];
    assert.doesNotThrow(() => computeMerged(server, [chatResumedFrame()]));
  });

  it('still returns the real transcript', () => {
    const server = [user('u1', 'hello', 0), assistant('a1', 'hi there', 1)];
    const merged = computeMerged(server, [chatResumedFrame()]);
    // The gateway frame has no id to dedupe on and renders as nothing, but the
    // point of this test is the two real rows: they must survive.
    assert.deepEqual(
      ids(merged).filter((id) => typeof id === 'string'),
      ['u1', 'a1'],
    );
  });

  it('does not swallow real rows that arrive alongside it', () => {
    const server = [user('u1', 'hello', 0)];
    const merged = computeMerged(server, [chatResumedFrame(), assistant('a1', 'reply', 3)]);
    assert.ok(ids(merged).includes('a1'), 'the assistant reply must still be merged');
  });

  it('does not treat an id-less row as one the server already has', () => {
    // `new Set([...].map(m => m.id))` puts `undefined` in the set when a server
    // row lacks an id, and `serverIds.has(undefined)` is then true — which would
    // silently discard every id-less realtime row as a duplicate.
    const serverWithBadRow = [chatResumedFrame(), user('u1', 'hello', 0)];
    assert.doesNotThrow(() => computeMerged(serverWithBadRow, [assistant('a1', 'reply', 3)]));
    const merged = computeMerged(serverWithBadRow, [assistant('a1', 'reply', 3)]);
    assert.ok(ids(merged).includes('a1'));
  });
});

describe('pruneRealtimeSupersededByServer with an id-less realtime row (#450)', () => {
  it('does not throw', () => {
    const server = [user('u1', 'hello', 0)];
    assert.doesNotThrow(() => pruneRealtimeSupersededByServer(server, [chatResumedFrame()]));
  });

  it('keeps a live row that the server has not persisted yet', () => {
    const server = [user('u1', 'hello', 0)];
    const kept = pruneRealtimeSupersededByServer(
      server,
      [chatResumedFrame(), assistant('a1', 'not on disk yet', 3)],
    );
    assert.ok(ids(kept).includes('a1'));
  });
});

describe('getUserTurnOrdinalBefore with an id-less realtime row (#450)', () => {
  it('does not throw', () => {
    const server = [user('u1', 'hello', 0), assistant('a1', 'hi', 1)];
    assert.doesNotThrow(() =>
      getUserTurnOrdinalBefore(assistant('a1', 'hi', 1), server, [chatResumedFrame()]));
  });
});

describe('recomputeMergedIfNeeded ref bookkeeping (#450/#389)', () => {
  /**
   * A row whose `id` throws on read. Stands in for any future merge failure —
   * the contract under test is "a throw must not leave the slot claiming it
   * merged these inputs", not this particular way of failing.
   */
  const explodingRow = (): NormalizedMessage => ({
    sessionId: SESSION_ID,
    timestamp: at(2),
    provider: 'claude',
    kind: 'text',
    get id(): string {
      throw new Error('merge exploded');
    },
  } as unknown as NormalizedMessage);

  it('merges normally when nothing goes wrong', () => {
    const slot = createEmptySlot();
    slot.serverMessages = [user('u1', 'hello', 0)];
    assert.equal(recomputeMergedIfNeeded(slot), true);
    assert.deepEqual(ids(slot.merged), ['u1']);
    // Second call with the same inputs short-circuits — that cache is the whole
    // point of the function and must keep working.
    assert.equal(recomputeMergedIfNeeded(slot), false);
  });

  it('does not claim inputs it failed to merge', () => {
    const slot = createEmptySlot();
    slot.serverMessages = [user('u1', 'hello', 0)];
    recomputeMergedIfNeeded(slot);

    const poisoned = [explodingRow()];
    slot.realtimeMessages = poisoned;
    assert.throws(() => recomputeMergedIfNeeded(slot), /merge exploded/);

    // The refs must still describe the last inputs that actually produced
    // `slot.merged`. If the failed inputs were claimed, this second call
    // short-circuits on reference equality and reports "already up to date"
    // for a merge that never happened — which is what froze `merged` forever
    // and left the chat dead until the app was reopened.
    assert.notEqual(slot._lastRealtimeRef, poisoned);
    assert.throws(() => recomputeMergedIfNeeded(slot), /merge exploded/);
  });

  it('recovers once the offending rows are gone', () => {
    const slot = createEmptySlot();
    slot.serverMessages = [user('u1', 'hello', 0)];
    recomputeMergedIfNeeded(slot);

    slot.realtimeMessages = [explodingRow()];
    assert.throws(() => recomputeMergedIfNeeded(slot));

    slot.realtimeMessages = [assistant('a1', 'reply', 3)];
    assert.equal(recomputeMergedIfNeeded(slot), true);
    assert.deepEqual(ids(slot.merged), ['u1', 'a1']);
  });
});
