import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore.pure';

import { retryPendingSends } from './pendingSendRetry';
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
