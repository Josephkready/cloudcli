import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore.pure';

import { DISPATCHED_RESEND_GRACE_MS, retryPendingSends } from './pendingSendRetry';
import type { PendingSend } from './pendingSends';

const SESSION = 's1';
const NOW = Date.parse('2026-08-11T15:00:00.000Z');

const pending = (over: Partial<PendingSend> = {}): PendingSend => ({
  id: 'p1',
  content: 'hello',
  timestamp: '2026-08-11T14:59:00.000Z',
  ...over,
});

// Only kind/role/content/timestamp are read by the echo matcher; the rest exist
// to satisfy the type.
const serverUserMessage = (content: string, timestamp: string): NormalizedMessage =>
  ({
    id: `srv_${content}`,
    sessionId: SESSION,
    timestamp,
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content,
  }) as NormalizedMessage;

function harness(entries: PendingSend[], serverMessages: NormalizedMessage[], sendResults: boolean[] = []) {
  const sent: any[] = [];
  let persisted: PendingSend[] | null = null;
  let call = 0;
  const result = retryPendingSends({
    sessionId: SESSION,
    serverMessages,
    entries,
    send: (message) => {
      sent.push(message);
      const ok = sendResults[call] ?? true;
      call += 1;
      return ok;
    },
    persist: (next) => {
      persisted = next;
    },
    now: () => NOW,
  });
  return { result, sent, persisted: persisted as PendingSend[] | null };
}

test('no pending entries does nothing at all — no send, no write', () => {
  const { result, sent, persisted } = harness([], []);
  assert.deepEqual(result, { confirmed: 0, resent: 0, stillPending: 0 });
  assert.equal(sent.length, 0);
  assert.equal(persisted, null);
});

// The message did reach the server before the socket died: the transcript has
// it, so resending would duplicate the user's message.
test('an entry the transcript already contains is confirmed, never resent', () => {
  const { result, sent, persisted } = harness(
    [pending({ content: 'landed' })],
    [serverUserMessage('landed', '2026-08-11T14:59:01.000Z')],
  );
  assert.equal(result.confirmed, 1);
  assert.equal(result.resent, 0);
  assert.equal(sent.length, 0);
  assert.deepEqual(persisted, []);
});

// The #325 case: nothing at send time said anything was wrong (half-open
// socket), and the transcript proves it never arrived.
test('an entry with no echo is resent as chat.send for the session', () => {
  const { result, sent, persisted } = harness([pending({ content: 'lost' })], []);
  assert.equal(result.confirmed, 0);
  assert.equal(result.resent, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: 'chat.send',
    sessionId: SESSION,
    content: 'lost',
    options: { images: [] },
  });
  assert.equal(persisted?.length, 1, 'stays pending until the server echoes it');
});

test('resent entries carry their queue-time options through', () => {
  const { sent } = harness([pending({ options: { model: 'sonnet', permissionMode: 'plan' } })], []);
  assert.deepEqual(sent[0].options, { model: 'sonnet', permissionMode: 'plan', images: [] });
});

// Restamping is what keeps a retry confirmable: echo matching only accepts a
// server row within a bounded window of the entry's timestamp, so an entry that
// sat through a long outage would never match again if it kept its old time.
test('a successfully resent entry is restamped to the send moment', () => {
  const { persisted } = harness([pending({ timestamp: '2026-08-11T10:00:00.000Z' })], []);
  assert.equal(persisted?.[0]?.timestamp, new Date(NOW).toISOString());
});

test('an entry whose resend failed keeps its ORIGINAL timestamp', () => {
  // It never left, so its eventual transcript row will correspond to the
  // original time — restamping here would move the window off that row.
  const original = '2026-08-11T10:00:00.000Z';
  const { result, persisted } = harness([pending({ timestamp: original })], [], [false]);
  assert.equal(result.resent, 0);
  assert.equal(persisted?.[0]?.timestamp, original);
  assert.equal(result.stillPending, 1);
});

test('a mix is split correctly: echoed confirmed, rest resent in order', () => {
  const entries = [
    pending({ id: 'a', content: 'first' }),
    pending({ id: 'b', content: 'landed' }),
    pending({ id: 'c', content: 'third' }),
  ];
  const { result, sent, persisted } = harness(entries, [
    serverUserMessage('landed', '2026-08-11T14:59:02.000Z'),
  ]);
  assert.equal(result.confirmed, 1);
  assert.equal(result.resent, 2);
  assert.deepEqual(sent.map((m) => m.content), ['first', 'third'], 'oldest-first order preserved');
  assert.deepEqual(persisted?.map((e) => e.id), ['a', 'c']);
});

// If the socket dies part-way through draining, continuing would let later
// messages overtake earlier ones on the next attempt.
test('a mid-drain socket failure stops dispatching and keeps the tail queued', () => {
  const entries = [
    pending({ id: 'a', content: 'one' }),
    pending({ id: 'b', content: 'two' }),
    pending({ id: 'c', content: 'three' }),
  ];
  const { result, sent, persisted } = harness(entries, [], [true, false]);
  assert.equal(result.resent, 1);
  assert.deepEqual(sent.map((m) => m.content), ['one', 'two'], 'stops after the failed write');
  assert.equal(result.stillPending, 3, 'nothing is dropped');
  assert.deepEqual(persisted?.map((e) => e.id), ['a', 'b', 'c']);
  assert.equal(persisted?.[1]?.timestamp, entries[1]?.timestamp, 'the failed one is not restamped');
  assert.equal(persisted?.[2]?.timestamp, entries[2]?.timestamp, 'the undispatched one is untouched');
});

/* ── the resend grace period: not duplicating a delivered message ────────── */

// The transcript indexer lags, so a message that DID arrive is briefly absent
// from serverMessages. Resending on that absence would ask the model the same
// thing twice — the server queues a duplicate chat.send rather than rejecting
// it, so this is a real user-visible duplicate, not a no-op.
test('a message that reached the socket moments ago is not resent yet', () => {
  const { result, sent, persisted } = harness(
    [pending({ dispatched: true, timestamp: new Date(NOW - 1_000).toISOString() })],
    [],
  );
  assert.equal(result.resent, 0);
  assert.equal(sent.length, 0);
  assert.equal(result.stillPending, 1, 'kept for a later pass, not dropped');
  assert.equal(persisted?.[0]?.timestamp, new Date(NOW - 1_000).toISOString());
});

test('once the grace period has passed, a dispatched-but-unechoed message is resent', () => {
  const { result, sent } = harness(
    [pending({ dispatched: true, timestamp: new Date(NOW - DISPATCHED_RESEND_GRACE_MS - 1).toISOString() })],
    [],
  );
  assert.equal(result.resent, 1);
  assert.equal(sent.length, 1);
});

// The clean-offline case carries no ambiguity: the socket refused the frame, so
// there is nothing in flight to duplicate and the user should not wait.
test('a message the socket refused is resent immediately, without waiting', () => {
  const { result, sent } = harness(
    [pending({ dispatched: false, timestamp: new Date(NOW - 500).toISOString() })],
    [],
  );
  assert.equal(result.resent, 1);
  assert.deepEqual(sent[0].content, 'hello');
});

test('a missing dispatched flag is read conservatively as dispatched', () => {
  const { result } = harness([pending({ timestamp: new Date(NOW - 1_000).toISOString() })], []);
  assert.equal(result.resent, 0, 'waits rather than risking a duplicate');
});

// Confirmation is independent of the grace period — if the transcript has it,
// it is done, however recently it was sent.
test('a recently dispatched message that IS echoed is confirmed, not held', () => {
  const timestamp = new Date(NOW - 1_000).toISOString();
  const { result, persisted } = harness(
    [pending({ content: 'landed', dispatched: true, timestamp })],
    [serverUserMessage('landed', new Date(NOW - 900).toISOString())],
  );
  assert.equal(result.confirmed, 1);
  assert.deepEqual(persisted, []);
});

test('a resent entry is marked dispatched so it starts its own grace period', () => {
  const { persisted } = harness(
    [pending({ dispatched: false, timestamp: new Date(NOW - 500).toISOString() })],
    [],
  );
  assert.equal(persisted?.[0]?.dispatched, true);
  assert.equal(persisted?.[0]?.timestamp, new Date(NOW).toISOString());
});

test('an entry whose resend failed stays flagged as never delivered', () => {
  const { persisted } = harness(
    [pending({ dispatched: false, timestamp: new Date(NOW - 500).toISOString() })],
    [],
    [false],
  );
  assert.equal(persisted?.[0]?.dispatched, false, 'still safe to retry without waiting');
});

// Guards the matcher's own boundary: a same-text server row far outside the
// dedupe window is a DIFFERENT message (the user asked the same thing later),
// so the pending entry is still unconfirmed.
test('a same-text server row outside the dedupe window does not confirm', () => {
  const { result } = harness(
    [pending({ content: 'ping', timestamp: '2026-08-11T10:00:00.000Z' })],
    [serverUserMessage('ping', '2026-08-11T14:59:00.000Z')],
  );
  assert.equal(result.confirmed, 0);
  assert.equal(result.resent, 1);
});
