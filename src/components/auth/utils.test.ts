import assert from 'node:assert/strict';
import test from 'node:test';

import type { ApiErrorPayload } from './types';
import { parseJsonSafely, resolveApiErrorMessage } from './utils';

// Small defensive helpers around the auth fetch responses: never throw on a
// non-JSON body, and pick the most useful error string with a guaranteed
// fallback.

test('parseJsonSafely resolves the decoded body on success', async () => {
  const response = { json: async () => ({ token: 't', user: { username: 'jo' } }) } as unknown as Response;
  assert.deepEqual(await parseJsonSafely(response), { token: 't', user: { username: 'jo' } });
});

test('parseJsonSafely returns null when the body is not JSON (json() rejects)', async () => {
  const response = {
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
  assert.equal(await parseJsonSafely(response), null);
});

test('resolveApiErrorMessage uses the fallback for a null payload', () => {
  assert.equal(resolveApiErrorMessage(null, 'fallback'), 'fallback');
});

test('resolveApiErrorMessage prefers error, then message, then the fallback', () => {
  assert.equal(resolveApiErrorMessage({ error: 'bad creds', message: 'ignored' }, 'fb'), 'bad creds');
  assert.equal(resolveApiErrorMessage({ message: 'server down' }, 'fb'), 'server down');
  assert.equal(resolveApiErrorMessage({} as ApiErrorPayload, 'fb'), 'fb');
});

test('resolveApiErrorMessage treats an empty-string error as present (nullish-coalescing)', () => {
  // `??` only falls through on null/undefined, so an explicit '' error wins.
  assert.equal(resolveApiErrorMessage({ error: '' }, 'fb'), '');
});
