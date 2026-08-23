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
