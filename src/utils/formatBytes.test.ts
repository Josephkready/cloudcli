import assert from 'node:assert/strict';
import test from 'node:test';

import { formatFileSize } from './formatBytes';

test('formatFileSize: zero, undefined, and sub-KB sizes', () => {
  assert.equal(formatFileSize(undefined), '0 B');
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(500), '500 B');
});

test('formatFileSize: scales into KB/MB/GB and trims a trailing .0', () => {
  assert.equal(formatFileSize(1024), '1 KB');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1024 * 1024), '1 MB');
  assert.equal(formatFileSize(1024 * 1024 * 1024), '1 GB');
});

// Regression for #173: the units array used to stop at GB and the index was
// unclamped, so any size >= 1 TB rendered "1 undefined".
test('formatFileSize: renders TB/PB units instead of "undefined" at large sizes', () => {
  const TB = 1024 ** 4;
  const PB = 1024 ** 5;
  assert.equal(formatFileSize(TB), '1 TB');
  assert.equal(formatFileSize(2 * TB), '2 TB');
  assert.equal(formatFileSize(1.5 * TB), '1.5 TB'); // trailing-.0 trim still applies at TB scale
  assert.equal(formatFileSize(PB), '1 PB');
});

// Past the largest defined unit (>= 1 EB) the index is clamped to PB rather
// than walking off the end of the array into `undefined`.
test('formatFileSize: clamps sizes beyond the largest unit to PB', () => {
  assert.equal(formatFileSize(1024 ** 6), '1024 PB');
});

// Sub-1-byte fractional inputs have a negative log index; the lower-bound clamp
// keeps them in the `B` bucket instead of indexing `sizes[-1]` -> "undefined".
test('formatFileSize: clamps sub-1-byte fractional sizes into the B unit', () => {
  assert.equal(formatFileSize(0.5), '0.5 B');
  assert.ok(!formatFileSize(0.5).includes('undefined'));
  assert.equal(formatFileSize(1), '1 B'); // boundary: rawIndex 0, no clamp needed
  assert.equal(formatFileSize(0.99), '1 B'); // clamped B branch still trims a trailing .0
});

// Out-of-domain inputs (negative, NaN, Infinity) can't be salvaged by clamping
// (Math.log -> NaN, which Math.min/max propagate), so they collapse to '0 B'
// rather than rendering "NaN undefined" / "Infinity PB".
test('formatFileSize: returns "0 B" for negative and non-finite inputs', () => {
  assert.equal(formatFileSize(-5), '0 B');
  assert.equal(formatFileSize(Number.NaN), '0 B');
  assert.equal(formatFileSize(Number.POSITIVE_INFINITY), '0 B');
  assert.equal(formatFileSize(Number.NEGATIVE_INFINITY), '0 B');
});
