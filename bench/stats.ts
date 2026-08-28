/**
 * Percentile math for the benchmark, kept dependency-free and pure so it can be
 * unit-tested without a browser.
 */

import type { Summary } from './types.js';

/**
 * Nearest-rank percentile on an already-sorted ascending array.
 *
 * Nearest-rank (rather than an interpolating variant) is deliberate: every
 * reported percentile is then an *observed* sample, so a p95 in the report can
 * always be traced back to a real iteration rather than to a number that never
 * happened. With the small N a browser benchmark can afford (5–20 iterations),
 * interpolation invents precision the sample size does not support.
 */
export function percentile(sortedAscending: number[], fraction: number): number {
  if (sortedAscending.length === 0) {
    return Number.NaN;
  }
  const rank = Math.ceil(fraction * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index];
}

/** Summarize a set of samples. Returns an all-NaN summary for an empty set. */
export function summarize(values: number[]): Summary {
  if (values.length === 0) {
    return { n: 0, min: Number.NaN, median: Number.NaN, p95: Number.NaN, max: Number.NaN, mean: Number.NaN };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((accumulator, value) => accumulator + value, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

/**
 * Relative change from `before` to `after`, as a signed fraction where negative
 * means faster.
 *
 * Returns `null` when `before` is zero or non-finite: a percentage against a
 * zero baseline is either infinite or meaningless, and printing "−100%" for a
 * step that never took measurable time would overstate a win.
 */
export function relativeDelta(before: number, after: number): number | null {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === 0) {
    return null;
  }
  return (after - before) / before;
}

/**
 * Round to a fixed number of decimals for display without dragging float noise
 * (`12.300000000000001`) into the JSON report.
 */
export function round(value: number, decimals = 1): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
