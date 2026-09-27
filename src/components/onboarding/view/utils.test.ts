import assert from 'node:assert/strict';
import test from 'node:test';

import { gitEmailPattern, readErrorMessageFromResponse } from './utils';

test('gitEmailPattern accepts a plausible email address', () => {
  assert.equal(gitEmailPattern.test('jo@example.com'), true);
});

test('gitEmailPattern rejects a string without an @ or domain', () => {
  assert.equal(gitEmailPattern.test('not-an-email'), false);
});

test('readErrorMessageFromResponse returns the server-provided error', async () => {
  const response = { json: async () => ({ error: 'bad request' }) } as unknown as Response;
  assert.equal(await readErrorMessageFromResponse(response, 'fallback'), 'bad request');
});

test('readErrorMessageFromResponse falls back when the payload has no error field', async () => {
  const response = { json: async () => ({}) } as unknown as Response;
  assert.equal(await readErrorMessageFromResponse(response, 'fallback'), 'fallback');
});

test('readErrorMessageFromResponse falls back when the body is not JSON', async () => {
  const response = {
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
  assert.equal(await readErrorMessageFromResponse(response, 'fallback'), 'fallback');
});
