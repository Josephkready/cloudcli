import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateDiff, createCachedDiffCalculator } from './messageTransforms';

/* ── calculateDiff ───────────────────────────────────────────────────────── */

test('calculateDiff: identical text produces no diff lines', () => {
  assert.deepEqual(calculateDiff('a\nb\nc', 'a\nb\nc'), []);
});

test('calculateDiff: a single deleted line is reported as one removal (LCS, not a cascade)', () => {
  // Removing the middle line must not re-flag the surrounding unchanged lines.
  assert.deepEqual(calculateDiff('a\nb\nc', 'a\nc'), [
    { type: 'removed', content: 'b', lineNum: 2 },
  ]);
});

test('calculateDiff: a single inserted line is reported as one addition', () => {
  assert.deepEqual(calculateDiff('a\nc', 'a\nb\nc'), [
    { type: 'added', content: 'b', lineNum: 2 },
  ]);
});

test('calculateDiff: a replaced line is a removal followed by an addition at the same position', () => {
  assert.deepEqual(calculateDiff('a', 'b'), [
    { type: 'removed', content: 'a', lineNum: 1 },
    { type: 'added', content: 'b', lineNum: 1 },
  ]);
});

test('calculateDiff: trailing appended lines keep growing line numbers', () => {
  assert.deepEqual(calculateDiff('a', 'a\nb\nc'), [
    { type: 'added', content: 'b', lineNum: 2 },
    { type: 'added', content: 'c', lineNum: 3 },
  ]);
});

test('calculateDiff: emptying a file removes every old line and adds the one empty line', () => {
  // Splitting '' yields a single empty line, so the new side still contributes one add.
  assert.deepEqual(calculateDiff('x\ny', ''), [
    { type: 'removed', content: 'x', lineNum: 1 },
    { type: 'removed', content: 'y', lineNum: 2 },
    { type: 'added', content: '', lineNum: 1 },
  ]);
});

test('calculateDiff: adding to empty content still reports the removed blank line', () => {
  // '' splits to [''] (one blank line), so the old blank line is reported removed
  // alongside the real addition — an asymmetric quirk worth pinning.
  assert.deepEqual(calculateDiff('', 'a'), [
    { type: 'removed', content: '', lineNum: 1 },
    { type: 'added', content: 'a', lineNum: 1 },
  ]);
});

test('calculateDiff: line numbers are per-side (old for removals, new for additions)', () => {
  // Replace the first of three lines: removal keeps old numbering, addition new.
  assert.deepEqual(calculateDiff('a\nb\nc', 'x\nb\nc'), [
    { type: 'removed', content: 'a', lineNum: 1 },
    { type: 'added', content: 'x', lineNum: 1 },
  ]);
});

/* ── createCachedDiffCalculator ──────────────────────────────────────────── */

test('createCachedDiffCalculator: returns the same array instance for repeated inputs', () => {
  const calc = createCachedDiffCalculator();
  const first = calc('a\nb', 'a\nc');
  const second = calc('a\nb', 'a\nc');
  assert.equal(first, second, 'cache hit must return the identical reference');
});

test('createCachedDiffCalculator: agrees with the uncached calculateDiff', () => {
  const calc = createCachedDiffCalculator();
  assert.deepEqual(calc('a\nb\nc', 'a\nc'), calculateDiff('a\nb\nc', 'a\nc'));
});

test('createCachedDiffCalculator: distinct inputs get distinct results', () => {
  const calc = createCachedDiffCalculator();
  const removal = calc('a\nb', 'a');
  const addition = calc('a', 'a\nb');
  assert.notDeepEqual(removal, addition);
});

test('createCachedDiffCalculator: evicts the oldest entry once the cache exceeds 100', () => {
  const calc = createCachedDiffCalculator();
  const original = calc('k0-old', 'k0-new');

  // 100 further distinct inputs push the cache to 101 entries, evicting k0.
  for (let i = 0; i < 100; i += 1) {
    calc(`x${i}`, `y${i}`);
  }

  const recomputed = calc('k0-old', 'k0-new');
  assert.notEqual(recomputed, original, 'evicted key should be recomputed as a fresh array');
  assert.deepEqual(recomputed, original, 'recomputed value must still be correct');
});
