import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectSession } from '../types/app';

import { getSessionDisplayName } from './sessionDisplayName';

const session = (over: Partial<ProjectSession> = {}): ProjectSession =>
  ({ id: '9087a325-bc69-49dd-bf3a-2a6ee529f4d2', ...over }) as ProjectSession;

test('prefers title, then summary, then name', () => {
  assert.equal(getSessionDisplayName(session({ title: 'T', summary: 'S', name: 'N' }), 'New Session'), 'T');
  assert.equal(getSessionDisplayName(session({ summary: 'S', name: 'N' }), 'New Session'), 'S');
  assert.equal(getSessionDisplayName(session({ name: 'N' }), 'New Session'), 'N');
});

test('falls back to the caller-supplied placeholder, never the session id', () => {
  const name = getSessionDisplayName(session(), 'New Session');
  assert.equal(name, 'New Session');
  assert.doesNotMatch(name, /[0-9a-f]{8}-[0-9a-f]{4}-/i);
});

test('treats empty strings as absent so a blank summary cannot render as a nameless row', () => {
  assert.equal(getSessionDisplayName(session({ title: '', summary: '', name: '' }), 'New Session'), 'New Session');
});

test('a missing session still yields the placeholder', () => {
  assert.equal(getSessionDisplayName(null, 'New Session'), 'New Session');
  assert.equal(getSessionDisplayName(undefined, 'New Session'), 'New Session');
});
