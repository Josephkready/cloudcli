import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore.pure';

import { retryPendingSends } from './pendingSendRetry';
import type { PendingSend } from './pendingSends';

/*
 * #347 / #350 — the same message delivered again, long after it arrived.
 *
 * Two transcripts, two platforms, same signature. iOS Safari: one 697-character
 * prompt reached Claude five times. Windows Chrome, different project: the same
 * prompt twice, 18 minutes apart. In both, the duplicate is the session's FIRST
 * message and every repeat lands 1-2s after a run completes — which is exactly
 * when `useChatSessionState` refetches the transcript and runs this function.
 *
 * The trap is that a resend restamps the entry to "now", while the echo matcher
 * will only accept a transcript row no older than `localTime - 10s`. So the
 * original row — written when the message actually arrived, minutes or hours
 * earlier — stops matching the moment the entry is restamped. The entry becomes
 * permanently unconfirmable and re-fires on every later refresh, forever.
 *
 * One spurious resend is a bug. A resend that makes the entry unconfirmable is
 * what turns it into five.
 */

const iso = (ms: number) => new Date(ms).toISOString();

const serverUserMessage = (content: string, atMs: number): NormalizedMessage =>
  ({ id: `srv_${atMs}`, kind: 'text', role: 'user', content, timestamp: iso(atMs) } as unknown as NormalizedMessage);

const entryFor = (content: string, atMs: number): PendingSend => ({
  id: 'pending_1',
  content,
  timestamp: iso(atMs),
  dispatched: true,
});

const CONTENT = 'Can you add /issue button. There should be a skill on how to do this';

/**
 * Drives one refresh: returns what was sent and what stayed pending.
 */
function runRefresh(options: {
  entries: PendingSend[];
  serverMessages: NormalizedMessage[];
  nowMs: number;
  transcriptComplete?: boolean;
}) {
  const sent: unknown[] = [];
  let persisted: PendingSend[] = [];

  const result = retryPendingSends({
    sessionId: 'sess-347',
    serverMessages: options.serverMessages,
    entries: options.entries,
    send: (message) => {
      sent.push(message);
      return true;
    },
    persist: (entries) => {
      persisted = entries;
    },
    now: () => options.nowMs,
    transcriptComplete: options.transcriptComplete ?? true,
  });

  return { ...result, sent, persisted };
}

test('an entry whose message is already in the transcript is confirmed, not resent', () => {
  const sentAt = Date.parse('2026-08-17T01:40:33Z');
  const refresh = runRefresh({
    entries: [entryFor(CONTENT, sentAt)],
    serverMessages: [serverUserMessage(CONTENT, sentAt)],
    nowMs: sentAt + 18 * 60_000,
  });

  assert.equal(refresh.resent, 0);
  assert.equal(refresh.confirmed, 1);
  assert.deepEqual(refresh.persisted, []);
});

// The heart of #347: replay the desktop transcript's shape. One spurious resend
// (the transcript had not been indexed yet at that refresh), then the row shows
// up — and every refresh after that must confirm it rather than send it again.
test('a resend does not make the original echo permanently unmatchable', () => {
  const sentAt = Date.parse('2026-08-17T01:40:33Z');
  const serverRow = serverUserMessage(CONTENT, sentAt);

  // Refresh 1: transcript slice does not carry the row yet, grace expired.
  const first = runRefresh({
    entries: [entryFor(CONTENT, sentAt)],
    serverMessages: [],
    nowMs: sentAt + 60_000,
  });
  assert.equal(first.resent, 1, 'setup: the unindexed refresh resends once');
  assert.equal(first.persisted.length, 1);

  // Refresh 2: the row is there now — 18 minutes older than the restamped entry.
  const second = runRefresh({
    entries: first.persisted,
    serverMessages: [serverRow],
    nowMs: sentAt + 18 * 60_000,
  });

  assert.equal(second.resent, 0, 'the transcript proves it arrived — do not send it again');
  assert.equal(second.confirmed, 1);
  assert.deepEqual(second.persisted, [], 'and the entry is retired');
});

test('the entry stops re-firing across many later refreshes', () => {
  const sentAt = Date.parse('2026-08-17T01:10:55Z');
  const serverRow = serverUserMessage(CONTENT, sentAt);

  let entries = [entryFor(CONTENT, sentAt)];
  let totalResent = 0;

  // One unindexed refresh, then four completion edges like the iOS transcript.
  const refreshes = [
    { messages: [] as NormalizedMessage[], at: sentAt + 45_000 },
    { messages: [serverRow], at: sentAt + 8 * 60_000 },
    { messages: [serverRow], at: sentAt + 9 * 60_000 },
    { messages: [serverRow], at: sentAt + 18 * 60_000 },
    { messages: [serverRow], at: sentAt + 19 * 60_000 },
  ];

  for (const refresh of refreshes) {
    const result = runRefresh({ entries, serverMessages: refresh.messages, nowMs: refresh.at });
    totalResent += result.resent;
    entries = result.persisted;
  }

  // The reporter saw five arrivals. One unavoidable resend is the most this
  // sequence may produce, and the queue must be empty afterwards.
  assert.equal(totalResent, 1, `expected a single resend, saw ${totalResent}`);
  assert.deepEqual(entries, []);
});

test('a genuinely unrelated older message with the same text does not confirm the entry', () => {
  // The window exists so an identical prompt from hours ago cannot be mistaken
  // for this one's echo. Widening the lower bound must not lose that.
  const sentAt = Date.parse('2026-08-17T01:40:33Z');
  const refresh = runRefresh({
    entries: [entryFor(CONTENT, sentAt)],
    serverMessages: [serverUserMessage(CONTENT, sentAt - 6 * 60 * 60_000)],
    nowMs: sentAt + 60_000,
  });

  assert.equal(refresh.confirmed, 0);
  assert.equal(refresh.resent, 1);
});

test('an echo arriving after a late resend still confirms the entry', () => {
  // The other direction: the entry sat unsent through an outage, went out on a
  // resend, and the transcript row lands near the RESEND time, far from the
  // original. That is what restamping was introduced to keep matchable.
  const firstAttempt = Date.parse('2026-08-17T01:00:00Z');
  const resendAt = firstAttempt + 40 * 60_000;

  const afterResend = runRefresh({
    entries: [{ ...entryFor(CONTENT, firstAttempt), dispatched: false }],
    serverMessages: [],
    nowMs: resendAt,
  });
  assert.equal(afterResend.resent, 1);

  const confirmed = runRefresh({
    entries: afterResend.persisted,
    serverMessages: [serverUserMessage(CONTENT, resendAt + 2_000)],
    nowMs: resendAt + 30_000,
  });

  assert.equal(confirmed.confirmed, 1);
  assert.equal(confirmed.resent, 0);
});

/*
 * Why the FIRST resend happened at all — and why it was always the session's
 * first message.
 *
 * `useChatSessionState` refetches with `limit: MESSAGES_PER_PAGE, offset: 0` and
 * hands that slice straight to `retryPendingSends`. It is a window over the most
 * recent messages, not the whole transcript. After a long run the session's
 * opening prompt has scrolled out of it, so "not in serverMessages" stopped
 * meaning "the server never received it" and started meaning "I did not look
 * that far back". The retry resent a message the server had had for 18 minutes.
 *
 * Absence is only evidence when the slice actually covers the entry.
 */

test('a partial transcript that does not reach the entry is inconclusive, not proof of loss', () => {
  const sentAt = Date.parse('2026-08-17T01:40:33Z');
  // The loaded page starts well after the entry was sent, and more remain.
  const recent = serverUserMessage('a later prompt', sentAt + 15 * 60_000);

  const refresh = runRefresh({
    entries: [entryFor(CONTENT, sentAt)],
    serverMessages: [recent],
    nowMs: sentAt + 18 * 60_000,
    transcriptComplete: false,
  });

  assert.equal(refresh.resent, 0, 'must not resend on the strength of an unloaded window');
  assert.equal(refresh.persisted.length, 1, 'the entry stays pending for a later, wider look');
});

test('a complete transcript that lacks the entry is still proof of loss', () => {
  const sentAt = Date.parse('2026-08-17T01:40:33Z');
  const refresh = runRefresh({
    entries: [entryFor(CONTENT, sentAt)],
    serverMessages: [serverUserMessage('a later prompt', sentAt + 60_000)],
    nowMs: sentAt + 5 * 60_000,
    transcriptComplete: true,
  });

  assert.equal(refresh.resent, 1, 'a fully-loaded transcript without it means it was lost');
});

test('a partial transcript still resends an entry it does cover', () => {
  // The window reaches back past the entry, so its absence is real: the whole
  // point of #325 recovery must keep working on a paginated session.
  const sentAt = Date.parse('2026-08-17T01:40:33Z');
  const older = serverUserMessage('something older', sentAt - 60_000);

  const refresh = runRefresh({
    entries: [entryFor(CONTENT, sentAt)],
    serverMessages: [older],
    nowMs: sentAt + 5 * 60_000,
    transcriptComplete: false,
  });

  assert.equal(refresh.resent, 1);
});

test('a partial transcript with no messages at all cannot judge anything', () => {
  const sentAt = Date.parse('2026-08-17T01:40:33Z');
  const refresh = runRefresh({
    entries: [entryFor(CONTENT, sentAt)],
    serverMessages: [],
    nowMs: sentAt + 5 * 60_000,
    transcriptComplete: false,
  });

  assert.equal(refresh.resent, 0);
  assert.equal(refresh.persisted.length, 1);
});
