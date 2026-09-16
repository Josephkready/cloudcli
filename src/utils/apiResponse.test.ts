import assert from 'node:assert/strict';
import test from 'node:test';

import { getApiErrorMessage, toResponseJson } from './apiResponse';

const FALLBACK = 'Failed to load';

// getApiErrorMessage is the user-visible error string for the MCP and skills
// panels. The server reports failures in three different shapes depending on
// the route, so the precedence between them is the whole behaviour.

test('getApiErrorMessage prefers a nested error.message', () => {
  assert.equal(
    getApiErrorMessage({ error: { message: 'nested detail' } }, FALLBACK),
    'nested detail',
  );
});

test('getApiErrorMessage reads a plain string error', () => {
  assert.equal(getApiErrorMessage({ error: 'flat detail' }, FALLBACK), 'flat detail');
});

test('getApiErrorMessage falls back to details', () => {
  assert.equal(getApiErrorMessage({ details: 'why it failed' }, FALLBACK), 'why it failed');
});

test('getApiErrorMessage prefers error over details when both are present', () => {
  assert.equal(
    getApiErrorMessage({ error: 'flat detail', details: 'ignored' }, FALLBACK),
    'flat detail',
  );
  assert.equal(
    getApiErrorMessage({ error: { message: 'nested detail' }, details: 'ignored' }, FALLBACK),
    'nested detail',
  );
});

test('getApiErrorMessage skips a nested error object with no usable message', () => {
  // An `{ error: {...} }` whose message is missing, blank, or not a string must
  // fall through to `details` rather than rendering "undefined".
  assert.equal(getApiErrorMessage({ error: {}, details: 'why' }, FALLBACK), 'why');
  assert.equal(getApiErrorMessage({ error: { message: '   ' }, details: 'why' }, FALLBACK), 'why');
  assert.equal(getApiErrorMessage({ error: { message: 42 }, details: 'why' }, FALLBACK), 'why');
});

test('getApiErrorMessage treats whitespace-only strings as absent', () => {
  assert.equal(getApiErrorMessage({ error: '   ' }, FALLBACK), FALLBACK);
  assert.equal(getApiErrorMessage({ details: '   ' }, FALLBACK), FALLBACK);
});

test('getApiErrorMessage returns the fallback for unusable payloads', () => {
  assert.equal(getApiErrorMessage(null, FALLBACK), FALLBACK);
  assert.equal(getApiErrorMessage(undefined, FALLBACK), FALLBACK);
  assert.equal(getApiErrorMessage('a bare string', FALLBACK), FALLBACK);
  assert.equal(getApiErrorMessage(42, FALLBACK), FALLBACK);
  assert.equal(getApiErrorMessage({}, FALLBACK), FALLBACK);
  assert.equal(getApiErrorMessage({ error: null }, FALLBACK), FALLBACK);
});

test('getApiErrorMessage never returns undefined or [object Object]', () => {
  const payloads: unknown[] = [
    null,
    undefined,
    {},
    { error: {} },
    { error: [] },
    { error: { message: {} } },
    { details: {} },
    [],
  ];

  for (const payload of payloads) {
    const message = getApiErrorMessage(payload, FALLBACK);
    assert.equal(typeof message, 'string');
    assert.ok(message.trim().length > 0, `blank message for ${JSON.stringify(payload)}`);
    assert.ok(!message.includes('[object Object]'), `leaked object for ${JSON.stringify(payload)}`);
  }
});

test('toResponseJson returns the parsed body', async () => {
  const response = { json: async () => ({ ok: true, count: 2 }) } as unknown as Response;
  assert.deepEqual(await toResponseJson<{ ok: boolean; count: number }>(response), {
    ok: true,
    count: 2,
  });
});

test('toResponseJson propagates a parse failure rather than swallowing it', async () => {
  const response = {
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;

  await assert.rejects(toResponseJson(response), SyntaxError);
});
