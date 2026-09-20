import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CACHED_MESSAGES_PER_SESSION,
  MAX_CACHED_SESSIONS,
  computeFingerprint,
  selectEvictions,
  shouldCacheTranscript,
  type CachedTranscriptMeta,
} from './transcriptCache.pure';
import type { NormalizedMessage } from './useSessionStore.pure';

function msg(id: string, timestamp = `2026-09-20T00:00:${id.padStart(2, '0')}.000Z`): NormalizedMessage {
  return { id, sessionId: 's', timestamp, provider: 'claude', kind: 'text', role: 'user', content: id } as NormalizedMessage;
}

test('computeFingerprint is stable for the same rows and changes on an appended tail', () => {
  const a = [msg('1'), msg('2'), msg('3')];
  assert.equal(computeFingerprint(a), computeFingerprint([msg('1'), msg('2'), msg('3')]));
  // Appending a row changes the count and the last-id/ts → different fingerprint.
  assert.notEqual(computeFingerprint(a), computeFingerprint([...a, msg('4')]));
  // Replacing the last row (same count) still changes it.
  assert.notEqual(computeFingerprint(a), computeFingerprint([msg('1'), msg('2'), msg('9')]));
});

test('computeFingerprint handles the empty transcript', () => {
  assert.equal(computeFingerprint([]), '0');
});

test('shouldCacheTranscript requires rows and rejects pathologically large threads', () => {
  assert.equal(shouldCacheTranscript([]), false);
  assert.equal(shouldCacheTranscript([msg('1')]), true);
  const big = Array.from({ length: MAX_CACHED_MESSAGES_PER_SESSION + 1 }, (_, i) => msg(String(i)));
  assert.equal(shouldCacheTranscript(big), false);
  const atCap = Array.from({ length: MAX_CACHED_MESSAGES_PER_SESSION }, (_, i) => msg(String(i)));
  assert.equal(shouldCacheTranscript(atCap), true);
});

function meta(sessionId: string, cachedAt: number): CachedTranscriptMeta {
  return { sessionId, cachedAt };
}

test('selectEvictions is a no-op under the cap', () => {
  const metas = [meta('a', 1), meta('b', 2)];
  assert.deepEqual(selectEvictions(metas, 'b', 5), []);
});

test('selectEvictions drops the oldest first down to the cap', () => {
  const metas = [meta('a', 10), meta('b', 20), meta('c', 30), meta('d', 40)];
  // Cap at 2, currently writing 'd'. Oldest two ('a','b') go.
  assert.deepEqual(selectEvictions(metas, 'd', 2).sort(), ['a', 'b']);
});

test('selectEvictions never evicts the session being written, even if oldest', () => {
  const metas = [meta('a', 10), meta('b', 20), meta('c', 30)];
  // Cap at 1, writing 'a' (the oldest). It is protected; the next-oldest 'b','c' go.
  const evicted = selectEvictions(metas, 'a', 1);
  assert.ok(!evicted.includes('a'), 'the session being written must survive');
  assert.deepEqual(evicted.sort(), ['b', 'c']);
});

test('MAX constants are sane defaults', () => {
  assert.ok(MAX_CACHED_SESSIONS > 0);
  assert.ok(MAX_CACHED_MESSAGES_PER_SESSION > 0);
});
