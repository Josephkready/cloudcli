import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SEEN_MESSAGE_MAX_PER_SESSION,
  SEEN_MESSAGE_TTL_MS,
  forgetSeenClientMessages,
  hasSeenClientMessage,
  rememberClientMessage,
  seenClientMessageCount,
  trackedSessionCount,
} from '@/modules/websocket/services/chat-send-dedupe.service.js';

/**
 * Expiry and eviction rules for `chat.send` duplicate suppression (#389).
 *
 * These are driven through an injected clock rather than the websocket handler,
 * because the interesting cases are an hour apart and 200 messages deep — a
 * handler-level test cannot reach them, which is how the TTL and the cap came
 * to be entirely unexercised in the first place.
 */

const T0 = Date.parse('2026-08-23T12:00:00.000Z');

test.beforeEach(() => {
  forgetSeenClientMessages();
});

test('an unseen id is not a duplicate', () => {
  assert.equal(hasSeenClientMessage('s1', 'a', T0), false);
});

test('a remembered id is a duplicate', () => {
  rememberClientMessage('s1', 'a', T0);
  assert.equal(hasSeenClientMessage('s1', 'a', T0), true);
});

test('an empty id is never remembered and never a duplicate', () => {
  // A client predating the ack sends no id; it must keep the old behaviour
  // rather than colliding with every other id-less send.
  rememberClientMessage('s1', '', T0);
  assert.equal(hasSeenClientMessage('s1', '', T0), false);
  assert.equal(seenClientMessageCount('s1'), 0);
});

test('sessions are isolated — the same id in two sessions is two messages', () => {
  // Client ids are only unique within one browser's storage, so collisions
  // across sessions are expected.
  rememberClientMessage('s1', 'shared', T0);
  assert.equal(hasSeenClientMessage('s2', 'shared', T0), false);
});

test('an id is still recognised just before the TTL expires', () => {
  rememberClientMessage('s1', 'a', T0);
  assert.equal(hasSeenClientMessage('s1', 'a', T0 + SEEN_MESSAGE_TTL_MS - 1), true);
});

test('an id is forgotten once the TTL has passed', () => {
  rememberClientMessage('s1', 'a', T0);
  assert.equal(hasSeenClientMessage('s1', 'a', T0 + SEEN_MESSAGE_TTL_MS + 1), false);
});

test('expiry is per id, so a fresh id survives an old one being reaped', () => {
  rememberClientMessage('s1', 'old', T0);
  rememberClientMessage('s1', 'new', T0 + SEEN_MESSAGE_TTL_MS - 1_000);

  const later = T0 + SEEN_MESSAGE_TTL_MS + 1;
  assert.equal(hasSeenClientMessage('s1', 'old', later), false);
  assert.equal(hasSeenClientMessage('s1', 'new', later), true);
});

test('the per-session cap evicts the oldest id first', () => {
  for (let i = 0; i < SEEN_MESSAGE_MAX_PER_SESSION; i += 1) {
    rememberClientMessage('s1', `id_${i}`, T0 + i);
  }
  assert.equal(seenClientMessageCount('s1'), SEEN_MESSAGE_MAX_PER_SESSION);
  assert.equal(hasSeenClientMessage('s1', 'id_0', T0), true);

  // One past the cap: the oldest goes, everything newer stays.
  rememberClientMessage('s1', 'one_too_many', T0 + SEEN_MESSAGE_MAX_PER_SESSION);

  assert.equal(seenClientMessageCount('s1'), SEEN_MESSAGE_MAX_PER_SESSION);
  assert.equal(hasSeenClientMessage('s1', 'id_0', T0), false, 'oldest evicted');
  assert.equal(hasSeenClientMessage('s1', 'id_1', T0), true, 'second-oldest retained');
  assert.equal(hasSeenClientMessage('s1', 'one_too_many', T0), true, 'newest retained');
});

test('the cap never lets one session grow without bound', () => {
  for (let i = 0; i < SEEN_MESSAGE_MAX_PER_SESSION * 3; i += 1) {
    rememberClientMessage('s1', `id_${i}`, T0 + i);
  }
  assert.equal(seenClientMessageCount('s1'), SEEN_MESSAGE_MAX_PER_SESSION);
});

test('forgetting one session leaves the others alone', () => {
  rememberClientMessage('s1', 'a', T0);
  rememberClientMessage('s2', 'b', T0);

  forgetSeenClientMessages('s1');

  assert.equal(hasSeenClientMessage('s1', 'a', T0), false);
  assert.equal(hasSeenClientMessage('s2', 'b', T0), true);
});

test('forgetting with no argument clears everything', () => {
  rememberClientMessage('s1', 'a', T0);
  rememberClientMessage('s2', 'b', T0);

  forgetSeenClientMessages();

  assert.equal(trackedSessionCount(), 0);
});

// The outer map is keyed by session id and would otherwise keep one entry per
// session that ever sent a message, for the life of the process.
test('a session whose ids have all expired stops being tracked at all', () => {
  rememberClientMessage('s1', 'a', T0);
  assert.equal(trackedSessionCount(), 1);

  hasSeenClientMessage('s1', 'anything', T0 + SEEN_MESSAGE_TTL_MS + 1);

  assert.equal(trackedSessionCount(), 0, 'the empty bucket must not linger');
});
