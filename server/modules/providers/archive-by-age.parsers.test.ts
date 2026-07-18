import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { parseArchiveByAgeDays, parseArchiveByAgeDaysQuery } from './archive-by-age.parsers.js';

// Assert a call throws an AppError carrying a 400 and the given error code.
// `label` names the offending input so a failing loop iteration says which
// value broke, not just which assertion line.
function assertRejects(run: () => unknown, code: string, label: string): void {
  assert.throws(
    run,
    (error: unknown) => {
      assert.ok(error instanceof AppError, `${label}: expected an AppError`);
      assert.equal(error.statusCode, 400, `${label}: expected a 400`);
      assert.equal(error.code, code, `${label}: expected code ${code}`);
      return true;
    },
    `${label}: expected a throw`,
  );
}

// Stable label for an arbitrary bad input (JSON where possible; undefined has
// no JSON form).
const describeInput = (value: unknown): string =>
  value === undefined ? 'undefined' : JSON.stringify(value);

test('parseArchiveByAgeDays accepts a positive number (including fractional)', () => {
  assert.equal(parseArchiveByAgeDays({ days: 30 }), 30);
  assert.equal(parseArchiveByAgeDays({ days: 7 }), 7);
  // Fractional ages are legal — the service supports sub-day cutoffs.
  assert.equal(parseArchiveByAgeDays({ days: 2.5 }), 2.5);
});

test('parseArchiveByAgeDays rejects a non-object body', () => {
  for (const bad of [null, undefined, 'nope', 42, true]) {
    assertRejects(() => parseArchiveByAgeDays(bad), 'INVALID_REQUEST_BODY', describeInput(bad));
  }
});

test('parseArchiveByAgeDays rejects a missing or non-number days (no coercion)', () => {
  // A string/array that Number() would happily coerce must still be rejected.
  for (const bad of [{}, { days: '30' }, { days: [7] }, { days: null }, { days: true }]) {
    assertRejects(() => parseArchiveByAgeDays(bad), 'INVALID_ARCHIVE_AGE', describeInput(bad));
  }
});

test('parseArchiveByAgeDays rejects a non-positive or non-finite days', () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertRejects(() => parseArchiveByAgeDays({ days: bad }), 'INVALID_ARCHIVE_AGE', `days=${bad}`);
  }
});

test('parseArchiveByAgeDaysQuery parses a numeric ?days= string', () => {
  assert.equal(parseArchiveByAgeDaysQuery('30'), 30);
  assert.equal(parseArchiveByAgeDaysQuery('7'), 7);
  assert.equal(parseArchiveByAgeDaysQuery('  90  '), 90);
  assert.equal(parseArchiveByAgeDaysQuery('2.5'), 2.5);
});

test('parseArchiveByAgeDaysQuery rejects missing, empty, array, and non-numeric values', () => {
  // `undefined` (absent), arrays (repeated `?days=`), and non-strings all read
  // as "no usable value" and are rejected rather than silently coerced.
  for (const bad of [undefined, '', '   ', ['30', '40'], 30, null]) {
    assertRejects(() => parseArchiveByAgeDaysQuery(bad), 'INVALID_ARCHIVE_AGE', describeInput(bad));
  }
  for (const bad of ['abc', '0', '-5', 'NaN', '1e999']) {
    // '1e999' parses to Infinity — must be rejected as non-finite.
    assertRejects(() => parseArchiveByAgeDaysQuery(bad), 'INVALID_ARCHIVE_AGE', describeInput(bad));
  }
});
