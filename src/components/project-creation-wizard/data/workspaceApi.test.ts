import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { api } from '../../../utils/api';

import {
  browseFilesystemFolders,
  buildCloneProgressPayload,
  cloneWorkspaceWithProgress,
} from './workspaceApi';

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

test('clone progress sends credentials in the request body rather than the URL', () => {
  assert.deepEqual(buildCloneProgressPayload({
    workspacePath: ' /workspace/demo ',
    githubUrl: ' https://github.com/org/repo.git ',
    tokenMode: 'new',
    selectedGithubToken: '',
    newGithubToken: ' secret-token ',
  }), {
    path: '/workspace/demo',
    githubUrl: 'https://github.com/org/repo.git',
    newGithubToken: 'secret-token',
  });
});

test('clone progress uses an authenticated POST body and consumes the completion event', async (t) => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => key === 'auth-token' ? 'bearer-secret' : null,
      setItem: () => {},
    },
  });
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response('data: {"type":"complete","project":{"id":"p1"}}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  });

  const project = await cloneWorkspaceWithProgress({
    workspacePath: '/workspace',
    githubUrl: 'https://github.com/org/repo.git',
    tokenMode: 'new',
    selectedGithubToken: '',
    newGithubToken: 'github-secret',
  }, { onProgress: () => {} });

  assert.equal(requestUrl, '/api/projects/clone-progress');
  assert.equal(requestInit?.method, 'POST');
  assert.equal(new Headers(requestInit?.headers).get('Authorization'), 'Bearer bearer-secret');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    path: '/workspace',
    githubUrl: 'https://github.com/org/repo.git',
    newGithubToken: 'github-secret',
  });
  assert.deepEqual(project, { id: 'p1' });
});

test('clone progress rejects server error events and dropped streams', async (t) => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} },
  });
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(
    'data: {"type":"error","message":"Clone rejected"}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  ));
  const params = {
    workspacePath: '/workspace',
    githubUrl: 'https://github.com/org/repo.git',
    tokenMode: 'stored' as const,
    selectedGithubToken: '42',
    newGithubToken: '',
  };

  await assert.rejects(
    cloneWorkspaceWithProgress(params, { onProgress: () => {} }),
    /Clone rejected/,
  );

  fetchMock.mock.mockImplementation(async () => new Response('', {
    headers: { 'content-type': 'text/event-stream' },
  }));
  await assert.rejects(
    cloneWorkspaceWithProgress(params, { onProgress: () => {} }),
    /Connection lost during clone/,
  );
});

mock.reset();
