import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import {
  DEFAULT_HIDE_CLI_ORIGIN_CHATS,
  filterCliOriginConversations,
  filterCliOriginSessions,
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

const project = { projectId: 'p1' };
const items = [
  { project, session: { id: 'a', origin: 'cli' as const } },
  { project, session: { id: 'b', origin: 'cloudcli' as const } },
  { project, session: { id: 'c' } },
];

test('filterCliOriginConversations drops only cli-origin rows when hiding', () => {
  assert.deepEqual(
    filterCliOriginConversations(items, true).map((item) => item.session.id),
    ['b', 'c'],
  );
});

test('filterCliOriginConversations preserves each row\'s project reference', () => {
  // Load-bearing: the row's project is handed to onSelect -> setSelectedProject,
  // so a filtered *copy* would push a truncated session list into app state.
  for (const item of filterCliOriginConversations(items, true)) {
    assert.equal(item.project, project);
  }
});

test('filterCliOriginConversations returns the input untouched when not hiding', () => {
  assert.equal(filterCliOriginConversations(items, false), items);
});

test('filterCliOriginConversations tolerates an empty list', () => {
  assert.deepEqual(filterCliOriginConversations([], true), []);
});
