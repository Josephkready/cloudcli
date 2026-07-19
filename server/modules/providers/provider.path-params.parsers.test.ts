import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import {
  normalizeProviderParam,
  parseProvider,
  parseSessionId,
  readPathParam,
} from './provider.path-params.parsers.js';

/** Assert that `fn` throws an `AppError` carrying the given `code` and 400 status. */
function assertRejects(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 400);
    return true;
  });
}

/* ── readPathParam ───────────────────────────────────────────────────────── */

test('readPathParam: returns a string param verbatim (no trim)', () => {
  assert.equal(readPathParam('claude', 'provider'), 'claude');
  // It does NOT trim — that is the caller's job (e.g. normalizeProviderParam).
  assert.equal(readPathParam('  spaced  ', 'provider'), '  spaced  ');
});

test('readPathParam: takes the first string entry of a repeated (array) param', () => {
  assert.equal(readPathParam(['a', 'b'], 'name'), 'a');
});

test('readPathParam: rejects missing/non-string params with the param name in the message', () => {
  assertRejects(() => readPathParam(undefined, 'sessionId'), 'INVALID_PATH_PARAMETER');
  assertRejects(() => readPathParam(null, 'sessionId'), 'INVALID_PATH_PARAMETER');
  assertRejects(() => readPathParam(7, 'sessionId'), 'INVALID_PATH_PARAMETER');
  // An array whose first entry is not a string is still invalid.
  assertRejects(() => readPathParam([7, 'b'], 'sessionId'), 'INVALID_PATH_PARAMETER');
  assertRejects(() => readPathParam([], 'sessionId'), 'INVALID_PATH_PARAMETER');
});

/* ── normalizeProviderParam ──────────────────────────────────────────────── */

test('normalizeProviderParam: trims and lowercases', () => {
  assert.equal(normalizeProviderParam('  Claude  '), 'claude');
  assert.equal(normalizeProviderParam('CODEX'), 'codex');
});

test('normalizeProviderParam: rejects non-string input', () => {
  assertRejects(() => normalizeProviderParam(undefined), 'INVALID_PATH_PARAMETER');
});

/* ── parseSessionId (security-relevant) ──────────────────────────────────── */

test('parseSessionId: accepts allow-list characters and trims surrounding whitespace', () => {
  assert.equal(parseSessionId('abc-123_v2.0'), 'abc-123_v2.0');
  assert.equal(parseSessionId('  trimmed-id  '), 'trimmed-id');
});

test('parseSessionId: enforces the 1..120 length bounds', () => {
  assert.equal(parseSessionId('x'), 'x'); // lower boundary: 1 char is valid
  const maxLen = 'a'.repeat(120);
  assert.equal(parseSessionId(maxLen), maxLen); // upper boundary: exactly 120 is valid
  assertRejects(() => parseSessionId('a'.repeat(121)), 'INVALID_SESSION_ID'); // 121 is too long
  assertRejects(() => parseSessionId(''), 'INVALID_SESSION_ID'); // empty
  assertRejects(() => parseSessionId('   '), 'INVALID_SESSION_ID'); // whitespace-only trims to empty
});

test('parseSessionId: rejects separator, whitespace, and NUL characters', () => {
  assertRejects(() => parseSessionId('../etc/passwd'), 'INVALID_SESSION_ID');
  assertRejects(() => parseSessionId('a/b'), 'INVALID_SESSION_ID');
  assertRejects(() => parseSessionId('a\\b'), 'INVALID_SESSION_ID');
  assertRejects(() => parseSessionId('a b'), 'INVALID_SESSION_ID'); // interior space
  assertRejects(() => parseSessionId('a\0b'), 'INVALID_SESSION_ID'); // NUL byte
});

// `.` is an allow-list character, so bare `.` / `..` (and any all-dots id) pass
// the pattern — but they're reserved filesystem names. A lone `..` used as a
// single path segment downstream would resolve to the parent, so they're
// rejected explicitly. See issue #181.
test('parseSessionId: rejects reserved dot-only segments (., .., ...)', () => {
  assertRejects(() => parseSessionId('.'), 'INVALID_SESSION_ID');
  assertRejects(() => parseSessionId('..'), 'INVALID_SESSION_ID');
  assertRejects(() => parseSessionId('...'), 'INVALID_SESSION_ID');
  // The guard is narrow: only *all-dots* ids are reserved. Ids that merely
  // contain dots — including a leading-dot id — carry non-dot chars and pass.
  assert.equal(parseSessionId('.hidden'), '.hidden');
  assert.equal(parseSessionId('a.b'), 'a.b');
});

test('parseSessionId: rejects a non-string / array path param before pattern-testing', () => {
  assertRejects(() => parseSessionId(undefined), 'INVALID_PATH_PARAMETER');
  // A repeated ?param arriving as an array reduces to its first entry, then is
  // pattern-tested — so a bad first entry fails the id check, not the read.
  assertRejects(() => parseSessionId(['a/b']), 'INVALID_SESSION_ID');
});

/* ── parseProvider ───────────────────────────────────────────────────────── */

test('parseProvider: accepts the four supported providers, case/whitespace-insensitively', () => {
  assert.equal(parseProvider('claude'), 'claude');
  assert.equal(parseProvider('CODEX'), 'codex');
  assert.equal(parseProvider('  Cursor '), 'cursor');
  assert.equal(parseProvider('opencode'), 'opencode');
});

test('parseProvider: rejects anything off the allow-list', () => {
  assertRejects(() => parseProvider('gpt'), 'UNSUPPORTED_PROVIDER');
  assertRejects(() => parseProvider(''), 'UNSUPPORTED_PROVIDER');
  // Non-string input fails at the read step first.
  assertRejects(() => parseProvider(undefined), 'INVALID_PATH_PARAMETER');
});
