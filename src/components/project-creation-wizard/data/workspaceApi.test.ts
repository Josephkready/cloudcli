import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { api } from '../../../utils/api';

import {
  browseFilesystemFolders,
  buildCloneProgressPayload,
  cloneWorkspaceWithProgress,
  createFolderInFilesystem,
  createProjectRequest,
  fetchGithubTokenCredentials,
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

test('clone progress sends a selected stored-token id without a raw token', () => {
  assert.deepEqual(buildCloneProgressPayload({
    workspacePath: '/workspace/demo',
    githubUrl: 'https://github.com/org/repo.git',
    tokenMode: 'stored',
    selectedGithubToken: '42',
    newGithubToken: 'must-not-be-sent',
  }), {
    path: '/workspace/demo',
    githubUrl: 'https://github.com/org/repo.git',
    githubTokenId: '42',
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

/* ── fetchGithubTokenCredentials ─────────────────────────────────────────── */

test('fetchGithubTokenCredentials: returns only active credentials', async (t) => {
  t.mock.method(api, 'get', async () => jsonResponse({
    credentials: [
      { id: 1, credential_name: 'active-one', is_active: true },
      { id: 2, credential_name: 'disabled-one', is_active: false },
    ],
  }));

  const result = await fetchGithubTokenCredentials();

  assert.deepEqual(result.map((c) => c.credential_name), ['active-one']);
});

test('fetchGithubTokenCredentials: defaults to an empty list when credentials is absent', async (t) => {
  t.mock.method(api, 'get', async () => jsonResponse({}));

  const result = await fetchGithubTokenCredentials();

  assert.deepEqual(result, []);
});

test('fetchGithubTokenCredentials: throws the server error message on failure', async (t) => {
  t.mock.method(api, 'get', async () => jsonResponse({ error: 'Not authorized' }, false));

  await assert.rejects(() => fetchGithubTokenCredentials(), /Not authorized/);
});

test('fetchGithubTokenCredentials: falls back to a generic message when the server sends none', async (t) => {
  t.mock.method(api, 'get', async () => jsonResponse({}, false));

  await assert.rejects(() => fetchGithubTokenCredentials(), /Failed to load GitHub tokens/);
});

/* ── createFolderInFilesystem ─────────────────────────────────────────────── */

test('createFolderInFilesystem: resolves with the server-reported path', async (t) => {
  t.mock.method(api, 'createFolder', async () => jsonResponse({ success: true, path: '/ws/new-folder' }));

  const result = await createFolderInFilesystem('/ws/new-folder');

  assert.equal(result, '/ws/new-folder');
});

test('createFolderInFilesystem: falls back to the requested path when the server omits it', async (t) => {
  t.mock.method(api, 'createFolder', async () => jsonResponse({ success: true }));

  const result = await createFolderInFilesystem('/ws/fallback');

  assert.equal(result, '/ws/fallback');
});

test('createFolderInFilesystem: throws the server error on failure', async (t) => {
  t.mock.method(api, 'createFolder', async () => jsonResponse({ error: 'Permission denied' }, false));

  await assert.rejects(() => createFolderInFilesystem('/ws/blocked'), /Permission denied/);
});

/* ── createProjectRequest ─────────────────────────────────────────────────── */

test('createProjectRequest: resolves with the created project on success', async (t) => {
  t.mock.method(api, 'createProject', async () => jsonResponse({ success: true, project: { id: 'p1' } }));

  const result = await createProjectRequest({ path: '/ws/demo' });

  assert.deepEqual(result, { id: 'p1' });
});

test('createProjectRequest: prefers details string over other error fields', async (t) => {
  t.mock.method(api, 'createProject', async () => jsonResponse({
    details: 'Disk full',
    error: 'ignored',
    message: 'also ignored',
  }, false));

  await assert.rejects(() => createProjectRequest({ path: '/ws/demo' }), /Disk full/);
});

test('createProjectRequest: falls back to a string error field', async (t) => {
  t.mock.method(api, 'createProject', async () => jsonResponse({ error: 'Bad path' }, false));

  await assert.rejects(() => createProjectRequest({ path: '/ws/demo' }), /Bad path/);
});

test('createProjectRequest: reads nested error.details when present', async (t) => {
  t.mock.method(api, 'createProject', async () => jsonResponse({
    error: { details: 'Nested detail message' },
  }, false));

  await assert.rejects(() => createProjectRequest({ path: '/ws/demo' }), /Nested detail message/);
});

test('createProjectRequest: reads nested error.message when details is absent', async (t) => {
  t.mock.method(api, 'createProject', async () => jsonResponse({
    error: { message: 'Nested message' },
  }, false));

  await assert.rejects(() => createProjectRequest({ path: '/ws/demo' }), /Nested message/);
});

test('createProjectRequest: builds a "path already exists" message from error.details.projectPath', async (t) => {
  t.mock.method(api, 'createProject', async () => jsonResponse({
    error: { details: { projectPath: '/ws/taken' } },
  }, false));

  await assert.rejects(
    () => createProjectRequest({ path: '/ws/taken' }),
    /Project path already exists: \/ws\/taken/,
  );
});

test('createProjectRequest: falls back to the top-level message field', async (t) => {
  t.mock.method(api, 'createProject', async () => jsonResponse({ message: 'Top-level message' }, false));

  await assert.rejects(() => createProjectRequest({ path: '/ws/demo' }), /Top-level message/);
});

test('createProjectRequest: falls back to a generic message when nothing usable is present', async (t) => {
  t.mock.method(api, 'createProject', async () => jsonResponse({}, false));

  await assert.rejects(() => createProjectRequest({ path: '/ws/demo' }), /Failed to create project/);
});

mock.reset();
