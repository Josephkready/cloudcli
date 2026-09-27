import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getErrorMessage,
  getProjectPath,
  isMcpScope,
  isMcpTransport,
  maskSecret,
} from './mcpFormatting';

/* ── maskSecret ──────────────────────────────────────────────────────────── */

test('maskSecret: fully masks values of four characters or fewer', () => {
  assert.equal(maskSecret(''), '****');
  assert.equal(maskSecret('abcd'), '****');
  assert.equal(maskSecret(null), '****');
  assert.equal(maskSecret(undefined), '****');
});

test('maskSecret: reveals the first and last two characters of longer values', () => {
  assert.equal(maskSecret('abcde'), 'ab****de');
  assert.equal(maskSecret('secret-value'), 'se****ue');
  assert.equal(maskSecret(12345), '12****45');
});

/* ── type guards + small helpers ─────────────────────────────────────────── */

test('isMcpScope: accepts the three known scopes only', () => {
  assert.equal(isMcpScope('user'), true);
  assert.equal(isMcpScope('local'), true);
  assert.equal(isMcpScope('project'), true);
  assert.equal(isMcpScope('global'), false);
  assert.equal(isMcpScope(42), false);
});

test('isMcpTransport: accepts stdio/http/sse only', () => {
  assert.equal(isMcpTransport('stdio'), true);
  assert.equal(isMcpTransport('http'), true);
  assert.equal(isMcpTransport('sse'), true);
  assert.equal(isMcpTransport('ws'), false);
  assert.equal(isMcpTransport(undefined), false);
});

test('getProjectPath: prefers fullPath, then path, then empty string', () => {
  assert.equal(getProjectPath({ fullPath: '/a', path: '/b' }), '/a');
  assert.equal(getProjectPath({ path: '/b' }), '/b');
  assert.equal(getProjectPath({ fullPath: '', path: '/b' }), '/b');
  assert.equal(getProjectPath({}), '');
});

test('getErrorMessage: unwraps Error instances and falls back otherwise', () => {
  assert.equal(getErrorMessage(new Error('boom')), 'boom');
  assert.equal(getErrorMessage('nope'), 'Unknown error');
  assert.equal(getErrorMessage(null), 'Unknown error');
});
