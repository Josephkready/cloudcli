import assert from 'node:assert/strict';
import test from 'node:test';

import { apiKeysMatch, readRequestBearerToken } from './auth.js';

test('apiKeysMatch accepts only the exact configured API key', () => {
  assert.equal(apiKeysMatch('correct-key', 'correct-key'), true);
  assert.equal(apiKeysMatch('correct-kex', 'correct-key'), false);
  assert.equal(apiKeysMatch('correct-key-extra', 'correct-key'), false);
  assert.equal(apiKeysMatch(undefined, 'correct-key'), false);
  assert.equal(apiKeysMatch(['correct-key'], 'correct-key'), false);
  assert.equal(apiKeysMatch('', ''), false);
});

test('REST authentication reads bearer headers and ignores query-string tokens', () => {
  assert.equal(readRequestBearerToken({
    headers: { authorization: 'Bearer header-token' },
    query: { token: 'query-token' },
  }), 'header-token');
  assert.equal(readRequestBearerToken({
    headers: {},
    query: { token: 'query-token' },
  }), null);
});
