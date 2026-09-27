import assert from 'node:assert/strict';
import test from 'node:test';

import { getNotificationSessionSummary } from './sessionSummary';

test('prefers the session summary over the fallback input', () => {
  const result = getNotificationSessionSummary({ summary: 'Fix the login bug' }, 'ignored input');
  assert.equal(result, 'Fix the login bug');
});

test('falls back to name, then title, when summary is absent', () => {
  assert.equal(getNotificationSessionSummary({ name: 'Refactor auth' }, 'x'), 'Refactor auth');
  assert.equal(getNotificationSessionSummary({ title: 'Ship the release' }, 'x'), 'Ship the release');
});

test('collapses internal whitespace', () => {
  const result = getNotificationSessionSummary({ summary: 'fix   the\n\nlogin  bug' }, 'x');
  assert.equal(result, 'fix the login bug');
});

test('truncates a long session summary to 80 chars with an ellipsis', () => {
  const long = 'a'.repeat(100);
  const result = getNotificationSessionSummary({ summary: long }, 'x');
  assert.equal(result?.length, 80);
  assert.ok(result?.endsWith('...'));
});

test('uses the fallback input when the session has no summary/name/title', () => {
  const result = getNotificationSessionSummary(null, '  hello world  ');
  assert.equal(result, 'hello world');
});

test('truncates a long fallback input the same way', () => {
  const long = 'b'.repeat(100);
  const result = getNotificationSessionSummary(undefined, long);
  assert.equal(result?.length, 80);
  assert.ok(result?.endsWith('...'));
});

test('returns null when both the session and the fallback input are empty', () => {
  assert.equal(getNotificationSessionSummary({}, '   '), null);
});
