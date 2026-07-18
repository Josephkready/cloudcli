import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import {
  parseArchiveByAgeDays,
  parseArchiveByAgeDaysQuery,
  parseOptionalBooleanQuery,
  parseSessionSearchLimit,
  parseSessionSearchQuery,
  readOptionalQueryString,
} from './provider.routes.parsers.js';

/** Assert that `fn` throws an `AppError` carrying the given `code` and 400 status. */
function assertRejects(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 400);
    return true;
  });
}

test('readOptionalQueryString: trims non-empty strings', () => {
  assert.equal(readOptionalQueryString('claude'), 'claude');
  assert.equal(readOptionalQueryString('  padded  '), 'padded');
});

test('readOptionalQueryString: returns undefined for empty/whitespace strings', () => {
  assert.equal(readOptionalQueryString(''), undefined);
  assert.equal(readOptionalQueryString('   '), undefined);
});

test('readOptionalQueryString: returns undefined for non-string inputs', () => {
  // Express surfaces repeated params (`?x=1&x=2`) as an array — not a string.
  assert.equal(readOptionalQueryString(['1', '2']), undefined);
  assert.equal(readOptionalQueryString(undefined), undefined);
  assert.equal(readOptionalQueryString(7), undefined);
  assert.equal(readOptionalQueryString(null), undefined);
  assert.equal(readOptionalQueryString({ toString: () => 'x' }), undefined);
});

test('parseOptionalBooleanQuery: parses the two literal strings (trimmed)', () => {
  assert.equal(parseOptionalBooleanQuery('true', 'force'), true);
  assert.equal(parseOptionalBooleanQuery('false', 'force'), false);
  assert.equal(parseOptionalBooleanQuery('  true  ', 'force'), true);
});

test('parseOptionalBooleanQuery: absent/empty/array values are undefined', () => {
  assert.equal(parseOptionalBooleanQuery(undefined, 'force'), undefined);
  assert.equal(parseOptionalBooleanQuery('', 'force'), undefined);
  assert.equal(parseOptionalBooleanQuery('   ', 'force'), undefined);
  // A repeated param arrives as a non-string array, which reads as "absent".
  assert.equal(parseOptionalBooleanQuery(['true', 'false'], 'force'), undefined);
});

test('parseOptionalBooleanQuery: rejects any other value (case-sensitive)', () => {
  assertRejects(() => parseOptionalBooleanQuery('True', 'force'), 'INVALID_QUERY_PARAMETER');
  assertRejects(() => parseOptionalBooleanQuery('1', 'force'), 'INVALID_QUERY_PARAMETER');
  assertRejects(() => parseOptionalBooleanQuery('yes', 'force'), 'INVALID_QUERY_PARAMETER');
});

test('parseArchiveByAgeDays: accepts a positive number body', () => {
  assert.equal(parseArchiveByAgeDays({ days: 7 }), 7);
  assert.equal(parseArchiveByAgeDays({ days: 90 }), 90);
  // Not required to be an integer — positive finite is enough.
  assert.equal(parseArchiveByAgeDays({ days: 1.5 }), 1.5);
});

test('parseArchiveByAgeDays: rejects non-object bodies', () => {
  assertRejects(() => parseArchiveByAgeDays(null), 'INVALID_REQUEST_BODY');
  assertRejects(() => parseArchiveByAgeDays(undefined), 'INVALID_REQUEST_BODY');
  assertRejects(() => parseArchiveByAgeDays('7'), 'INVALID_REQUEST_BODY');
  assertRejects(() => parseArchiveByAgeDays(7), 'INVALID_REQUEST_BODY');
});

test('parseArchiveByAgeDays: rejects non-number, non-positive, non-finite days', () => {
  assertRejects(() => parseArchiveByAgeDays({}), 'INVALID_ARCHIVE_AGE');
  assertRejects(() => parseArchiveByAgeDays({ days: 0 }), 'INVALID_ARCHIVE_AGE');
  assertRejects(() => parseArchiveByAgeDays({ days: -5 }), 'INVALID_ARCHIVE_AGE');
  assertRejects(() => parseArchiveByAgeDays({ days: Number.NaN }), 'INVALID_ARCHIVE_AGE');
  assertRejects(() => parseArchiveByAgeDays({ days: Infinity }), 'INVALID_ARCHIVE_AGE');
  // No string/array coercion — `{ days: '7' }` / `{ days: [7] }` must be rejected,
  // not quietly coerced to 7.
  assertRejects(() => parseArchiveByAgeDays({ days: '7' }), 'INVALID_ARCHIVE_AGE');
  assertRejects(() => parseArchiveByAgeDays({ days: [7] }), 'INVALID_ARCHIVE_AGE');
});

test('parseArchiveByAgeDaysQuery: parses a positive numeric query string', () => {
  assert.equal(parseArchiveByAgeDaysQuery('7'), 7);
  assert.equal(parseArchiveByAgeDaysQuery('  30  '), 30);
  // Query strings go through Number(), so fractional/scientific forms are accepted.
  assert.equal(parseArchiveByAgeDaysQuery('7.5'), 7.5);
  assert.equal(parseArchiveByAgeDaysQuery('1e2'), 100);
});

test('parseArchiveByAgeDaysQuery: rejects missing, empty, non-numeric, non-positive', () => {
  assertRejects(() => parseArchiveByAgeDaysQuery(undefined), 'INVALID_ARCHIVE_AGE');
  assertRejects(() => parseArchiveByAgeDaysQuery(''), 'INVALID_ARCHIVE_AGE');
  assertRejects(() => parseArchiveByAgeDaysQuery('   '), 'INVALID_ARCHIVE_AGE');
  assertRejects(() => parseArchiveByAgeDaysQuery('abc'), 'INVALID_ARCHIVE_AGE');
  assertRejects(() => parseArchiveByAgeDaysQuery('0'), 'INVALID_ARCHIVE_AGE');
  assertRejects(() => parseArchiveByAgeDaysQuery('-5'), 'INVALID_ARCHIVE_AGE');
  // Repeated `?days=1&days=2` arrives as an array → treated as absent → rejected.
  assertRejects(() => parseArchiveByAgeDaysQuery(['1', '2']), 'INVALID_ARCHIVE_AGE');
});

test('parseSessionSearchQuery: accepts trimmed queries of length >= 2', () => {
  assert.equal(parseSessionSearchQuery('ab'), 'ab');
  assert.equal(parseSessionSearchQuery('  hello  '), 'hello');
});

test('parseSessionSearchQuery: rejects queries shorter than 2 chars after trimming', () => {
  assertRejects(() => parseSessionSearchQuery('a'), 'INVALID_SEARCH_QUERY');
  assertRejects(() => parseSessionSearchQuery(' a '), 'INVALID_SEARCH_QUERY');
  assertRejects(() => parseSessionSearchQuery(''), 'INVALID_SEARCH_QUERY');
  assertRejects(() => parseSessionSearchQuery(undefined), 'INVALID_SEARCH_QUERY');
  assertRejects(() => parseSessionSearchQuery(['ab', 'cd']), 'INVALID_SEARCH_QUERY');
});

test('parseSessionSearchLimit: defaults to 50 when absent', () => {
  assert.equal(parseSessionSearchLimit(undefined), 50);
  assert.equal(parseSessionSearchLimit(''), 50);
  assert.equal(parseSessionSearchLimit('   '), 50);
  assert.equal(parseSessionSearchLimit(['1', '2']), 50);
});

test('parseSessionSearchLimit: clamps into [1, 100]', () => {
  assert.equal(parseSessionSearchLimit('10'), 10);
  assert.equal(parseSessionSearchLimit('0'), 1);
  assert.equal(parseSessionSearchLimit('-5'), 1);
  assert.equal(parseSessionSearchLimit('999'), 100);
  assert.equal(parseSessionSearchLimit('100'), 100);
  // parseInt truncates trailing garbage.
  assert.equal(parseSessionSearchLimit('10.9'), 10);
});

test('parseSessionSearchLimit: rejects non-numeric limits', () => {
  assertRejects(() => parseSessionSearchLimit('abc'), 'INVALID_QUERY_PARAMETER');
});
