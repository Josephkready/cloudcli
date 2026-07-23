import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import type { Project } from '../../../types/app';

import {
  DEFAULT_HIDE_CLI_ORIGIN_CHATS,
  filterCliOriginSessions,
  filterCliOriginSessionsFromProjects,
  readHideCliOriginChats,
} from './utils';

// #216: a global preference (default ON) hides sessions started outside
// CloudCLI (`origin === 'cli'`). The `tsx --test` runner has no DOM, so the
// preference reader gets the same localStorage stub `readProjectSortOrder.test`
// uses. The two filter helpers are pure and need no stub.

let store: Record<string, string> = {};
const localStorageStub = {
  getItem: (key: string) => (key in store ? store[key] : null),
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    store = {};
  },
} as unknown as Storage;

beforeEach(() => {
  store = {};
  (globalThis as { localStorage?: Storage }).localStorage = localStorageStub;
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

test('the shipped default hides CLI-origin chats', () => {
  assert.equal(DEFAULT_HIDE_CLI_ORIGIN_CHATS, true);
});

test('defaults to hiding when nothing is stored', () => {
  assert.equal(readHideCliOriginChats(), true);
});

test('defaults to hiding when settings exist without the key', () => {
  store['claude-settings'] = JSON.stringify({ projectSortOrder: 'name' });
  assert.equal(readHideCliOriginChats(), true);
});

test('preserves an explicitly saved preference in both directions', () => {
  store['claude-settings'] = JSON.stringify({ hideCliOriginChats: false });
  assert.equal(readHideCliOriginChats(), false);

  store['claude-settings'] = JSON.stringify({ hideCliOriginChats: true });
  assert.equal(readHideCliOriginChats(), true);
});

test('ignores a non-boolean stored value and falls back to the default', () => {
  for (const bogus of ['false', 0, null, {}]) {
    store['claude-settings'] = JSON.stringify({ hideCliOriginChats: bogus });
    assert.equal(readHideCliOriginChats(), true);
  }
});

test('falls back to hiding on corrupt settings JSON', () => {
  store['claude-settings'] = '{not valid json';
  assert.equal(readHideCliOriginChats(), true);
});

const sessions = [
  { id: 'a', origin: 'cli' as const },
  { id: 'b', origin: 'cloudcli' as const },
  { id: 'c' },
];

test('filterCliOriginSessions drops only cli-origin sessions when hiding', () => {
  assert.deepEqual(
    filterCliOriginSessions(sessions, true).map((session) => session.id),
    ['b', 'c'],
  );
});

test('filterCliOriginSessions returns the input untouched when not hiding', () => {
  // Identity, not a copy: the un-filtered path must not churn referential
  // equality and re-run every downstream useMemo.
  assert.equal(filterCliOriginSessions(sessions, false), sessions);
});

test('filterCliOriginSessions tolerates an empty list', () => {
  assert.deepEqual(filterCliOriginSessions([], true), []);
});

function projectWith(projectId: string, origins: (string | undefined)[]): Project {
  return {
    projectId,
    displayName: projectId,
    fullPath: `/repos/${projectId}`,
    sessions: origins.map((origin, index) => ({ id: `${projectId}-${index}`, origin })),
  } as unknown as Project;
}

test('filterCliOriginSessionsFromProjects strips cli sessions per project', () => {
  const projects = [projectWith('p1', ['cli', 'cloudcli']), projectWith('p2', [undefined])];
  const filtered = filterCliOriginSessionsFromProjects(projects, true);

  assert.deepEqual(
    filtered.map((project) => project.sessions?.map((session) => session.id)),
    [['p1-1'], ['p2-0']],
  );
});

test('filterCliOriginSessionsFromProjects drops projects left with no sessions', () => {
  const projects = [projectWith('p1', ['cli', 'cli']), projectWith('p2', ['cloudcli'])];
  const filtered = filterCliOriginSessionsFromProjects(projects, true);

  assert.deepEqual(filtered.map((project) => project.projectId), ['p2']);
});

test('filterCliOriginSessionsFromProjects tolerates a project with no sessions array', () => {
  const projects = [{ projectId: 'p1', displayName: 'p1', fullPath: '/p1' } as unknown as Project];
  assert.deepEqual(filterCliOriginSessionsFromProjects(projects, true), []);
});

test('filterCliOriginSessionsFromProjects returns the input untouched when not hiding', () => {
  const projects = [projectWith('p1', ['cli'])];
  assert.equal(filterCliOriginSessionsFromProjects(projects, false), projects);
});
