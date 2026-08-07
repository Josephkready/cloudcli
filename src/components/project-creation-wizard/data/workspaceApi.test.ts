import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { api } from '../../../utils/api';

import { browseFilesystemFolders } from './workspaceApi';

/*
 * #238: the folder picker needs to know whether it is sitting at
 * WORKSPACES_ROOT so it can hide the ".." row, which at the root can only ever
 * produce a 403. The browse endpoint reports that as `isAtRoot`; these lock in
 * that the client surfaces it (and defaults it safely when it is absent).
 */

const jsonResponse = (payload: unknown, ok = true) => ({
  ok,
  json: async () => payload,
}) as unknown as Response;

test('browseFilesystemFolders: surfaces isAtRoot from the browse response', async (t) => {
  t.mock.method(api, 'get', async () => jsonResponse({
    path: '/var/tmp/audit',
    suggestions: [{ name: 'demo', path: '/var/tmp/audit/demo', type: 'directory' }],
    isAtRoot: true,
  }));

  const result = await browseFilesystemFolders('~');

  assert.equal(result.isAtRoot, true);
  assert.equal(result.path, '/var/tmp/audit');
  assert.equal(result.suggestions.length, 1);
});

test('browseFilesystemFolders: reports isAtRoot false when below the root', async (t) => {
  t.mock.method(api, 'get', async () => jsonResponse({
    path: '/var/tmp/audit/demo',
    suggestions: [],
    isAtRoot: false,
  }));

  const result = await browseFilesystemFolders('/var/tmp/audit/demo');

  assert.equal(result.isAtRoot, false);
});

test('browseFilesystemFolders: defaults isAtRoot to false when the field is missing', async (t) => {
  // An older/other server build that does not send the field must not make the
  // picker silently drop the ".." row everywhere.
  t.mock.method(api, 'get', async () => jsonResponse({ path: '/some/dir', suggestions: [] }));

  const result = await browseFilesystemFolders('/some/dir');

  assert.equal(result.isAtRoot, false);
});

/*
 * #309: the picker lists repositories rather than descending into every
 * subfolder, so it asks the endpoint to tag entries. That tagging costs a stat
 * per entry server-side, so it has to stay opt-in — the path-autocomplete
 * caller must keep asking without it.
 */

test('browseFilesystemFolders: omits repoFlags unless the caller opts in', async (t) => {
  const get = t.mock.method(api, 'get', async () => jsonResponse({ path: '~', suggestions: [] }));

  await browseFilesystemFolders('~');

  assert.equal(get.mock.calls[0].arguments[0], '/browse-filesystem?path=~');
});

test('browseFilesystemFolders: requests repoFlags when repository flags are wanted', async (t) => {
  const get = t.mock.method(api, 'get', async () => jsonResponse({ path: '~', suggestions: [] }));

  await browseFilesystemFolders('~', { includeRepositoryFlags: true });

  assert.equal(get.mock.calls[0].arguments[0], '/browse-filesystem?path=~&repoFlags=1');
});

test('browseFilesystemFolders: passes the isRepository flag through to the caller', async (t) => {
  t.mock.method(api, 'get', async () => jsonResponse({
    path: '/var/tmp/audit',
    suggestions: [
      { name: 'demo', path: '/var/tmp/audit/demo', type: 'directory', isRepository: true },
      { name: 'scratch', path: '/var/tmp/audit/scratch', type: 'directory', isRepository: false },
    ],
    isAtRoot: true,
  }));

  const result = await browseFilesystemFolders('~', { includeRepositoryFlags: true });

  assert.deepEqual(
    result.suggestions.map((entry) => entry.isRepository),
    [true, false],
  );
});

test('browseFilesystemFolders: still throws the server error on a failed browse', async (t) => {
  t.mock.method(api, 'get', async () => jsonResponse(
    { error: 'Workspace path must be within the allowed workspace root: /var/tmp/audit' },
    false,
  ));

  await assert.rejects(
    () => browseFilesystemFolders('/var/tmp'),
    /allowed workspace root/,
  );
});

mock.reset();
