import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import {
  parseChangeActiveModelPayload,
  parseMcpScope,
  parseSessionRenameSummary,
} from './provider.body.parsers.js';

/** Assert that `fn` throws an `AppError` carrying the given `code` and 400 status. */
function assertRejects(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 400);
    return true;
  });
}

/* ── parseMcpScope ───────────────────────────────────────────────────────── */

test('parseMcpScope: returns undefined for absent or empty values', () => {
  assert.equal(parseMcpScope(undefined), undefined);
  assert.equal(parseMcpScope(''), undefined);
  assert.equal(parseMcpScope('   '), undefined);
  // A repeated ?param arrives as a non-string array -> reads as absent.
  assert.equal(parseMcpScope(['user', 'local']), undefined);
});

test('parseMcpScope: accepts the three valid scopes (trimmed)', () => {
  assert.equal(parseMcpScope('user'), 'user');
  assert.equal(parseMcpScope('local'), 'local');
  assert.equal(parseMcpScope('  project  '), 'project');
});

test('parseMcpScope: rejects an unsupported scope', () => {
  assertRejects(() => parseMcpScope('global'), 'INVALID_MCP_SCOPE');
});

/* ── parseSessionRenameSummary ───────────────────────────────────────────── */

test('parseSessionRenameSummary: trims and returns a non-empty summary', () => {
  assert.equal(parseSessionRenameSummary({ summary: '  New title  ' }), 'New title');
});

test('parseSessionRenameSummary: enforces the 500-character upper bound', () => {
  const maxLen = 'a'.repeat(500);
  assert.equal(parseSessionRenameSummary({ summary: maxLen }), maxLen); // boundary: 500 is allowed
  assertRejects(
    () => parseSessionRenameSummary({ summary: 'a'.repeat(501) }),
    'INVALID_SESSION_SUMMARY',
  );
});

test('parseSessionRenameSummary: requires an object body with a non-empty summary', () => {
  assertRejects(() => parseSessionRenameSummary(null), 'INVALID_REQUEST_BODY');
  assertRejects(() => parseSessionRenameSummary({}), 'INVALID_SESSION_SUMMARY');
  assertRejects(() => parseSessionRenameSummary({ summary: '   ' }), 'INVALID_SESSION_SUMMARY');
  assertRejects(() => parseSessionRenameSummary({ summary: 42 }), 'INVALID_SESSION_SUMMARY');
});

/* ── parseChangeActiveModelPayload ───────────────────────────────────────── */

test('parseChangeActiveModelPayload: returns the model with an empty placeholder sessionId', () => {
  const result = parseChangeActiveModelPayload({ model: 'opus' });
  assert.equal(result.model, 'opus');
  // The route fills sessionId in from the path param; the parser leaves it blank.
  assert.equal(result.sessionId, '');
});

test('parseChangeActiveModelPayload: requires an object body with a model', () => {
  assertRejects(() => parseChangeActiveModelPayload(undefined), 'INVALID_REQUEST_BODY');
  assertRejects(() => parseChangeActiveModelPayload({}), 'MODEL_REQUIRED');
  assertRejects(() => parseChangeActiveModelPayload({ model: '   ' }), 'MODEL_REQUIRED');
});
