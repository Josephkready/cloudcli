import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { percentile, relativeDelta, round, summarize } from './stats.js';

/*
 * The arithmetic every benchmark claim is made of.
 *
 * Worth testing precisely because it is small: a nearest-rank percentile is one
 * `Math.ceil` away from being an off-by-one, and `relativeDelta`'s zero guard is
 * the difference between "no measurable change" and a reported −100%. An error
 * here would not crash anything — it would quietly restate a regression as an
 * improvement in the table used to justify a merge.
 */

describe('percentile', () => {
  it('returns an observed sample, not an interpolated one', () => {
    const sorted = [10, 20, 30, 40];

    // Nearest-rank: p50 of four samples is the 2nd, i.e. 20 — not 25. Every
    // number in a report should be traceable to an iteration that happened.
    assert.equal(percentile(sorted, 0.5), 20);
    assert.equal(percentile(sorted, 0.95), 40);
  });

  it('clamps at both ends instead of running off the array', () => {
    const sorted = [1, 2, 3];

    assert.equal(percentile(sorted, 0), 1);
    assert.equal(percentile(sorted, 1), 3);
    // Out-of-range fractions must not produce `undefined`.
    assert.equal(percentile(sorted, 2), 3);
    assert.equal(percentile(sorted, -1), 1);
  });

  it('is NaN for an empty set rather than undefined', () => {
    assert.ok(Number.isNaN(percentile([], 0.5)));
  });

  it('handles a single sample', () => {
    assert.equal(percentile([42], 0.5), 42);
    assert.equal(percentile([42], 0.95), 42);
  });
});

describe('summarize', () => {
  it('reports min, median, p95, max and mean over unsorted input', () => {
    const summary = summarize([30, 10, 50, 20, 40]);

    assert.equal(summary.n, 5);
    assert.equal(summary.min, 10);
    assert.equal(summary.median, 30);
    assert.equal(summary.p95, 50);
    assert.equal(summary.max, 50);
    assert.equal(summary.mean, 30);
  });

  it('does not mutate the caller\'s array', () => {
    const values = [3, 1, 2];
    summarize(values);

    assert.deepEqual(values, [3, 1, 2]);
  });

  it('is all-NaN with n = 0 for an empty set', () => {
    const summary = summarize([]);

    assert.equal(summary.n, 0);
    for (const key of ['min', 'median', 'p95', 'max', 'mean'] as const) {
      assert.ok(Number.isNaN(summary[key]), `${key} should be NaN`);
    }
  });
});

describe('relativeDelta', () => {
  it('is negative when the after value is faster', () => {
    assert.equal(relativeDelta(100, 75), -0.25);
  });

  it('is positive when the after value is slower', () => {
    assert.equal(relativeDelta(100, 125), 0.25);
  });

  it('refuses to report a percentage against a zero baseline', () => {
    // The alternative is `Infinity` or a confident "−100%" for a step that never
    // took measurable time — either would overstate a win.
    assert.equal(relativeDelta(0, 10), null);
    assert.equal(relativeDelta(0, 0), null);
  });

  it('refuses non-finite inputs', () => {
    assert.equal(relativeDelta(Number.NaN, 10), null);
    assert.equal(relativeDelta(10, Number.NaN), null);
    assert.equal(relativeDelta(Number.POSITIVE_INFINITY, 10), null);
  });
});

describe('round', () => {
  it('keeps float noise out of the report', () => {
    assert.equal(round(12.3000000000001), 12.3);
    assert.equal(round(1234.5678, 0), 1235);
    assert.equal(round(1.2345, 2), 1.23);
    // Deliberately not asserting a `x.xx5` case: those are ambiguous in binary
    // floating point (1.005 is stored just below 1.005), so pinning one would
    // be testing IEEE-754 rather than this function.
    assert.equal(round(2.675, 1), 2.7);
  });

  it('passes non-finite values through untouched', () => {
    assert.ok(Number.isNaN(round(Number.NaN)));
    assert.equal(round(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  });
});
