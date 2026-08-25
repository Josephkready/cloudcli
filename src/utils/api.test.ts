import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from './api';

test('conversation search URLs contain search inputs but no bearer token', () => {
  const url = api.searchConversationsUrl('fix login', 25);
  const parsed = new URL(url, 'https://cloudcli.example');

  assert.equal(parsed.searchParams.get('q'), 'fix login');
  assert.equal(parsed.searchParams.get('limit'), '25');
  assert.equal(parsed.searchParams.has('token'), false);
});

test('logout explicitly sends the token being revoked without reading storage', async (t) => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Refreshed-Token': 'ignored' },
    });
  });

  await api.auth.logout('token-being-revoked');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, '/api/auth/logout');
  assert.equal(requests[0].init?.method, 'POST');
  assert.deepEqual(requests[0].init?.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer token-being-revoked',
  });
});
