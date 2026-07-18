import test from 'node:test';
import assert from 'node:assert/strict';

import type { TFunction } from 'i18next';

import { formatTimeAgo } from './dateUtils';

// formatTimeAgo is fully deterministic: `currentTime` is injected (no Date.now())
// and `t` is optional. We pass `t` as null to exercise the built-in English
// fallback strings, and a stub `t` to prove the i18n key + interpolation.

const NOW = new Date('2026-01-15T12:00:00.000Z');
const noT = null as unknown as TFunction;
// Build an ISO timestamp `ms` before NOW.
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('invalid date string returns the unknown fallback', () => {
  assert.equal(formatTimeAgo('not-a-date', NOW, noT), 'Unknown');
});

test('under a minute → "Just now" (boundary at 60s)', () => {
  assert.equal(formatTimeAgo(ago(30 * SEC), NOW, noT), 'Just now');
  assert.equal(formatTimeAgo(ago(59 * SEC), NOW, noT), 'Just now');
  // 60s is no longer "just now" — it rolls to one minute.
  assert.equal(formatTimeAgo(ago(60 * SEC), NOW, noT), '1 min ago');
});

test('minutes are singular at 1 and pluralized below an hour', () => {
  assert.equal(formatTimeAgo(ago(90 * SEC), NOW, noT), '1 min ago');
  assert.equal(formatTimeAgo(ago(5 * MIN), NOW, noT), '5 mins ago');
  assert.equal(formatTimeAgo(ago(59 * MIN), NOW, noT), '59 mins ago');
});

test('hours are singular at 1 and pluralized below a day', () => {
  assert.equal(formatTimeAgo(ago(61 * MIN), NOW, noT), '1 hour ago');
  assert.equal(formatTimeAgo(ago(3 * HOUR), NOW, noT), '3 hours ago');
  assert.equal(formatTimeAgo(ago(23 * HOUR), NOW, noT), '23 hours ago');
});

test('days are singular at 1 and pluralized below a week', () => {
  assert.equal(formatTimeAgo(ago(25 * HOUR), NOW, noT), '1 day ago');
  assert.equal(formatTimeAgo(ago(3 * DAY), NOW, noT), '3 days ago');
  assert.equal(formatTimeAgo(ago(6 * DAY), NOW, noT), '6 days ago');
});

test('a week or more falls through to an absolute date, not a relative phrase', () => {
  const result = formatTimeAgo(ago(10 * DAY), NOW, noT);
  assert.ok(!result.includes('ago'), 'should not be a relative "... ago" phrase');
  assert.notEqual(result, 'Just now');
  assert.notEqual(result, 'Unknown');
  assert.ok(result.length > 0);
  // It is specifically the localized calendar date of the input.
  assert.equal(result, new Date(ago(10 * DAY)).toLocaleDateString());
});

test('uses the provided translator with the right key and count', () => {
  const calls: Array<{ key: string; count?: number }> = [];
  const t = ((key: string, opts?: { count?: number }) => {
    calls.push({ key, count: opts?.count });
    return opts?.count != null ? `${key}#${opts.count}` : key;
  }) as unknown as TFunction;

  assert.equal(formatTimeAgo(ago(30 * SEC), NOW, t), 'time.justNow');
  assert.equal(formatTimeAgo(ago(5 * MIN), NOW, t), 'time.minutesAgo#5');
  assert.equal(formatTimeAgo(ago(2 * HOUR), NOW, t), 'time.hoursAgo#2');
  assert.equal(formatTimeAgo('not-a-date', NOW, t), 'status.unknown');

  assert.deepEqual(calls, [
    { key: 'time.justNow', count: undefined },
    { key: 'time.minutesAgo', count: 5 },
    { key: 'time.hoursAgo', count: 2 },
    { key: 'status.unknown', count: undefined },
  ]);
});
