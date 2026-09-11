import assert from 'node:assert/strict';
import test from 'node:test';

import { readTokenBudgetOutput, readTokenBudgetUsed, reconcileTokenBudget } from './tokenBudget';

/*
 * #240. Payloads below are the ones captured on the wire in the issue:
 * the live frame and the REST response the initial fetch used to clobber it
 * with while JSONL indexing was still catching up.
 */

const LIVE_FRAME = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

const UNINDEXED_SERVER = {
  used: 0,
  total: 160000,
  breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
};

const INDEXED_SERVER = {
  used: 120,
  total: 160000,
  breakdown: { input: 100, cacheCreation: 0, cacheRead: 0 },
};

/* ── readTokenBudgetUsed ─────────────────────────────────────────────────── */

test('reads the live frame shape from inputTokens alone, not input + output', () => {
  // `inputTokens` already folds in both cache counters (see buildTokenBudget
  // in server/claude-sdk.js) — it IS the context size. Adding `outputTokens`
  // on top double-counted the reply the model just generated as if it were
  // already resent input, which is exactly what produced "200,000 tokens,
  // then 50,000": the number swung by however many output tokens the last
  // streamed chunk happened to carry.
  assert.equal(readTokenBudgetUsed(LIVE_FRAME), 100);
});

test('reads the REST shape from `used`', () => {
  assert.equal(readTokenBudgetUsed(INDEXED_SERVER), 120);
  assert.equal(readTokenBudgetUsed(UNINDEXED_SERVER), 0);
});

test('falls back to the breakdown sum when `used` is absent', () => {
  assert.equal(
    readTokenBudgetUsed({ breakdown: { input: 70, cacheCreation: 20, cacheRead: 10 } }),
    100,
  );
});

test('treats a missing budget as zero rather than NaN', () => {
  assert.equal(readTokenBudgetUsed(null), 0);
  assert.equal(readTokenBudgetUsed(undefined), 0);
  assert.equal(readTokenBudgetUsed({ used: 'not-a-number' }), 0);
});

/* ── readTokenBudgetOutput ───────────────────────────────────────────────── */

test('reads cumulative output tokens from the live frame', () => {
  assert.equal(readTokenBudgetOutput(LIVE_FRAME), 20);
});

test('returns null (not 0) for the REST shape, which carries no output figure', () => {
  assert.equal(readTokenBudgetOutput(INDEXED_SERVER), null);
  assert.equal(readTokenBudgetOutput(null), null);
});

/* ── reconcileTokenBudget ────────────────────────────────────────────────── */

test('an unindexed server response cannot clobber a newer live frame', () => {
  const reconciled = reconcileTokenBudget(LIVE_FRAME, UNINDEXED_SERVER);

  assert.deepEqual(reconciled, LIVE_FRAME);
  assert.equal(readTokenBudgetUsed(reconciled), 100);
});

test('the server value takes over once indexing has caught up', () => {
  const reconciled = reconcileTokenBudget(LIVE_FRAME, INDEXED_SERVER);

  assert.deepEqual(reconciled, INDEXED_SERVER);
});

test('a server value that has moved ahead of the last live frame wins', () => {
  const reconciled = reconcileTokenBudget(LIVE_FRAME, { used: 5000, total: 160000 });

  assert.equal(readTokenBudgetUsed(reconciled), 5000);
});

test('a real reading smaller than what is on screen replaces it — compaction must show a drop', () => {
  // Context size is not monotonic. A mid-session compaction rebuilds the
  // transcript into a short summary, and the next real reading is genuinely
  // smaller than the pre-compaction high-water mark. The old "keep whichever
  // reports more" rule got this backwards and pinned the display at its
  // highest-ever value forever; only the explicit unindexed-zero shape may be
  // refused now.
  const preCompaction = { used: 199_500, total: 200_000, breakdown: { input: 500, cacheCreation: 2_000, cacheRead: 197_000 } };
  const postCompaction = { used: 1_500, total: 200_000, breakdown: { input: 300, cacheCreation: 0, cacheRead: 1_200 } };

  const reconciled = reconcileTokenBudget(preCompaction, postCompaction);

  assert.deepEqual(reconciled, postCompaction);
  assert.equal(readTokenBudgetUsed(reconciled), 1_500);
});

test('a live frame applies straight away when nothing is on screen yet', () => {
  assert.deepEqual(reconcileTokenBudget(null, LIVE_FRAME), LIVE_FRAME);
});

test('a null incoming value leaves the current one alone', () => {
  // A failed/404 fetch must not blank a budget the run already reported.
  assert.deepEqual(reconcileTokenBudget(LIVE_FRAME, null), LIVE_FRAME);
});

test('an unindexed zero is refused regardless of arrival order', () => {
  const liveFirst = reconcileTokenBudget(
    reconcileTokenBudget(null, LIVE_FRAME),
    UNINDEXED_SERVER,
  );
  const serverFirst = reconcileTokenBudget(
    reconcileTokenBudget(null, UNINDEXED_SERVER),
    LIVE_FRAME,
  );

  assert.equal(readTokenBudgetUsed(liveFirst), 100);
  assert.equal(readTokenBudgetUsed(serverFirst), 100);
});
