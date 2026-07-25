import assert from 'node:assert/strict';
import test from 'node:test';

import { readTokenBudgetUsed, reconcileTokenBudget } from './tokenBudget';

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

test('reads the live frame shape by summing input and output', () => {
  assert.equal(readTokenBudgetUsed(LIVE_FRAME), 120);
});

test('reads the REST shape from `used`', () => {
  assert.equal(readTokenBudgetUsed(INDEXED_SERVER), 120);
  assert.equal(readTokenBudgetUsed(UNINDEXED_SERVER), 0);
});

test('falls back to the breakdown when only that is present', () => {
  assert.equal(readTokenBudgetUsed({ breakdown: { input: 70, output: 30 } }), 100);
});

test('treats a missing budget as zero rather than NaN', () => {
  assert.equal(readTokenBudgetUsed(null), 0);
  assert.equal(readTokenBudgetUsed(undefined), 0);
  assert.equal(readTokenBudgetUsed({ used: 'not-a-number' }), 0);
});

/* ── reconcileTokenBudget ────────────────────────────────────────────────── */

test('an unindexed server response cannot clobber a newer live frame', () => {
  const reconciled = reconcileTokenBudget(LIVE_FRAME, UNINDEXED_SERVER);

  assert.deepEqual(reconciled, LIVE_FRAME);
  assert.equal(readTokenBudgetUsed(reconciled), 120);
});

test('the server value takes over once indexing has caught up', () => {
  const reconciled = reconcileTokenBudget(LIVE_FRAME, INDEXED_SERVER);

  // Ties go to the server shape: it carries `total`, which the modal needs.
  assert.deepEqual(reconciled, INDEXED_SERVER);
});

test('a server value that has moved ahead of the last live frame wins', () => {
  const reconciled = reconcileTokenBudget(LIVE_FRAME, { used: 5000, total: 160000 });

  assert.equal(readTokenBudgetUsed(reconciled), 5000);
});

test('a live frame applies straight away when nothing is on screen yet', () => {
  assert.deepEqual(reconcileTokenBudget(null, LIVE_FRAME), LIVE_FRAME);
});

test('a null incoming value leaves the current one alone', () => {
  // A failed/404 fetch must not blank a budget the run already reported.
  assert.deepEqual(reconcileTokenBudget(LIVE_FRAME, null), LIVE_FRAME);
});

test('reconciling is order-insensitive: usage never goes backwards', () => {
  const liveFirst = reconcileTokenBudget(
    reconcileTokenBudget(null, LIVE_FRAME),
    UNINDEXED_SERVER,
  );
  const serverFirst = reconcileTokenBudget(
    reconcileTokenBudget(null, UNINDEXED_SERVER),
    LIVE_FRAME,
  );

  assert.equal(readTokenBudgetUsed(liveFirst), 120);
  assert.equal(readTokenBudgetUsed(serverFirst), 120);
});
