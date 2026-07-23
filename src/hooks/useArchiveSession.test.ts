import test from 'node:test';
import assert from 'node:assert/strict';

import { archiveSessionRequest } from './useArchiveSession';

// The shared soft-archive used by both the sidebar rows and the chat view's
// header button. It must always send a NON-force delete (archive, not destroy)
// and only deselect/refresh when the server accepted.

const t = (key: string, fallback?: string) => fallback ?? key;

const ok = () => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response;
const fail = () => ({ ok: false, status: 500, text: async () => 'boom' }) as unknown as Response;

function silenceConsoleError() {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

test('archives with hardDelete=false and notifies the caller', async () => {
  const calls: Array<[string, boolean]> = [];
  const deleted: string[] = [];
  let archivedRefreshes = 0;

  const result = await archiveSessionRequest('s1', {
    t,
    onSessionDelete: (id) => deleted.push(id),
    onArchived: () => {
      archivedRefreshes += 1;
    },
    deleteSession: async (id, hardDelete) => {
      calls.push([id, hardDelete]);
      return ok();
    },
    notifyError: () => assert.fail('should not notify on success'),
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [['s1', false]], 'must soft-archive, never force-delete');
  assert.deepEqual(deleted, ['s1'], 'the session must be dropped/deselected');
  assert.equal(archivedRefreshes, 1);
});

test('does not deselect when the server rejects the archive', async () => {
  const restore = silenceConsoleError();
  const deleted: string[] = [];
  const errors: string[] = [];

  const result = await archiveSessionRequest('s1', {
    t,
    onSessionDelete: (id) => deleted.push(id),
    deleteSession: async () => fail(),
    notifyError: (message) => errors.push(message),
  });
  restore();

  assert.equal(result, false);
  assert.deepEqual(deleted, [], 'a failed archive must leave the session selected');
  assert.deepEqual(errors, ['Failed to archive session. Please try again.']);
});

test('surfaces a network error without deselecting', async () => {
  const restore = silenceConsoleError();
  const deleted: string[] = [];
  const errors: string[] = [];

  const result = await archiveSessionRequest('s1', {
    t,
    onSessionDelete: (id) => deleted.push(id),
    deleteSession: async () => {
      throw new Error('offline');
    },
    notifyError: (message) => errors.push(message),
  });
  restore();

  assert.equal(result, false);
  assert.deepEqual(deleted, []);
  assert.deepEqual(errors, ['Error archiving session. Please try again.']);
});
