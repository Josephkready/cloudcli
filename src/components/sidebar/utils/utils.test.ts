import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project, ProjectSession } from '../../../types/app';
import type { SessionWithProvider } from '../types/types';
import { makeTranslator, withLocalStorage } from '../../../test/nodeStubs';

import {
  getSessionDate,
  getSessionName,
  getSessionTime,
  createSessionViewModel,
  getAllSessions,
  getProjectLastActivity,
  filterProjects,
  normalizeProjectForSettings,
  readLegacyStarredProjectIds,
  clearLegacyStarredProjectIds,
  sortProjects,
} from './utils';

// Companion to sortProjects.test.ts / readProjectSortOrder.test.ts: those pin
// the count/star sort + the persisted sort-order read; this file covers the
// per-session derivation, filtering, settings normalization, the date/name
// sort branches, and the legacy localStorage-star migration helpers.

const session = (over: Partial<ProjectSession> = {}): SessionWithProvider =>
  ({ id: 's1', ...over } as SessionWithProvider);

const project = (over: Partial<Project> = {}): Project => ({
  projectId: 'p',
  displayName: 'p',
  fullPath: '/repos/p',
  sessions: [],
  ...over,
});

// ── timestamp derivation ────────────────────────────────────────────────────

test('getSessionDate prefers lastActivity, then createdAt/created_at, else epoch 0', () => {
  assert.equal(
    getSessionDate(session({ lastActivity: '2026-03-02T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z' })).toISOString(),
    '2026-03-02T00:00:00.000Z',
  );
  assert.equal(
    getSessionDate(session({ createdAt: '2021-05-05T00:00:00.000Z' })).toISOString(),
    '2021-05-05T00:00:00.000Z',
  );
  // Snake-case created_at is honored when camelCase is absent.
  assert.equal(
    getSessionDate(session({ created_at: '2019-09-09T00:00:00.000Z' })).toISOString(),
    '2019-09-09T00:00:00.000Z',
  );
  // No timestamps at all -> the epoch (new Date(0)), not an Invalid Date.
  assert.equal(getSessionDate(session()).getTime(), 0);
});

test('getSessionTime returns the raw updated-or-created string (not a Date)', () => {
  assert.equal(getSessionTime(session({ lastActivity: 'A', createdAt: 'B' })), 'A');
  assert.equal(getSessionTime(session({ createdAt: 'B' })), 'B');
  assert.equal(getSessionTime(session()), '');
});

test('getSessionName falls back summary -> name -> translated placeholder', () => {
  const t = makeTranslator();
  assert.equal(getSessionName(session({ summary: 'Summ', name: 'Nm' }), t), 'Summ');
  assert.equal(getSessionName(session({ name: 'Nm' }), t), 'Nm');
  assert.equal(getSessionName(session(), t), 'projects.newSession');
});

// ── view model ──────────────────────────────────────────────────────────────

test('createSessionViewModel marks sessions active only within 10 minutes', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  const t = makeTranslator();

  const recent = createSessionViewModel(
    session({ lastActivity: '2026-01-01T11:55:00.000Z', summary: 'Recent', messageCount: 4 }),
    now,
    t,
  );
  assert.equal(recent.isActive, true);
  assert.equal(recent.sessionName, 'Recent');
  assert.equal(recent.sessionTime, '2026-01-01T11:55:00.000Z');
  assert.equal(recent.messageCount, 4);

  const stale = createSessionViewModel(
    session({ lastActivity: '2026-01-01T11:30:00.000Z' }),
    now,
    t,
  );
  assert.equal(stale.isActive, false);
});

test('createSessionViewModel coerces a non-numeric messageCount to 0', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  const vm = createSessionViewModel(
    session({ messageCount: undefined }),
    now,
    makeTranslator(),
  );
  assert.equal(vm.messageCount, 0);
});

// ── project-level aggregation ────────────────────────────────────────────────

test('getAllSessions tags each session with a resolved provider and sorts newest first', () => {
  const p = project({
    sessions: [
      session({ id: 'old', lastActivity: '2025-01-01T00:00:00.000Z', provider: 'codex' }),
      session({ id: 'new', lastActivity: '2026-01-01T00:00:00.000Z' }),
      session({ id: 'blank', lastActivity: '2024-06-01T00:00:00.000Z', provider: '   ' as never }),
    ],
  });

  const sorted = getAllSessions(p);
  assert.deepEqual(sorted.map((s) => s.id), ['new', 'old', 'blank']);
  // provider carried through; blank/whitespace provider defaults to 'claude'.
  assert.equal(sorted.find((s) => s.id === 'old')?.__provider, 'codex');
  assert.equal(sorted.find((s) => s.id === 'blank')?.__provider, 'claude');
  assert.equal(sorted.find((s) => s.id === 'new')?.__provider, 'claude');
});

test('getAllSessions returns [] when a project has no sessions array', () => {
  assert.deepEqual(getAllSessions(project({ sessions: undefined })), []);
});

test('getProjectLastActivity returns the newest session date, or epoch 0 when empty', () => {
  assert.equal(getProjectLastActivity(project({ sessions: [] })).getTime(), 0);
  const p = project({
    sessions: [
      session({ id: 'a', lastActivity: '2024-01-01T00:00:00.000Z' }),
      session({ id: 'b', lastActivity: '2026-07-07T00:00:00.000Z' }),
      session({ id: 'c', lastActivity: '2025-01-01T00:00:00.000Z' }),
    ],
  });
  assert.equal(getProjectLastActivity(p).toISOString(), '2026-07-07T00:00:00.000Z');
});

// ── filtering ────────────────────────────────────────────────────────────────

test('filterProjects returns every project when the filter is blank/whitespace', () => {
  const projects = [project({ projectId: 'a' }), project({ projectId: 'b' })];
  assert.equal(filterProjects(projects, ''), projects);
  assert.equal(filterProjects(projects, '   '), projects);
});

test('filterProjects matches displayName or path/fullPath, case-insensitively', () => {
  const projects = [
    project({ projectId: 'x', displayName: 'Alpha Service', fullPath: '/repos/alpha' }),
    project({ projectId: 'y', displayName: 'Beta', path: '/work/BETA-app', fullPath: '' }),
    project({ projectId: 'z', displayName: 'Gamma', fullPath: '/repos/gamma' }),
  ];
  assert.deepEqual(filterProjects(projects, 'ALPHA').map((p) => p.projectId), ['x']);
  // Matches on the path even when the display name doesn't contain the term.
  assert.deepEqual(filterProjects(projects, 'beta-app').map((p) => p.projectId), ['y']);
  assert.deepEqual(filterProjects(projects, 'zzz'), []);
});

// ── settings normalization ───────────────────────────────────────────────────

test('normalizeProjectForSettings keeps projectId as name and resolves the best path', () => {
  const full = normalizeProjectForSettings(
    project({ projectId: 'id1', displayName: 'Nice', fullPath: '/full', path: '/p' }),
  );
  assert.deepEqual(full, { name: 'id1', displayName: 'Nice', fullPath: '/full', path: '/p' });

  // fullPath empty -> falls back to path for BOTH fullPath and path.
  const fromPath = normalizeProjectForSettings(project({ projectId: 'id2', displayName: '  ', fullPath: '', path: '/only' }));
  assert.equal(fromPath.fullPath, '/only');
  assert.equal(fromPath.path, '/only');
  // Blank displayName -> projectId.
  assert.equal(fromPath.displayName, 'id2');
});

// ── legacy localStorage star migration ───────────────────────────────────────

test('readLegacyStarredProjectIds parses, trims, and drops empties from a JSON array', () => {
  withLocalStorage({ starredProjects: JSON.stringify([' a ', 'b', '', '  ', 3]) }, () => {
    assert.deepEqual(readLegacyStarredProjectIds(), ['a', 'b', '3']);
  });
});

test('readLegacyStarredProjectIds returns [] for missing, non-array, or malformed JSON', () => {
  withLocalStorage({}, () => {
    assert.deepEqual(readLegacyStarredProjectIds(), []);
  });
  withLocalStorage({ starredProjects: JSON.stringify({ not: 'an array' }) }, () => {
    assert.deepEqual(readLegacyStarredProjectIds(), []);
  });
  withLocalStorage({ starredProjects: 'not-json{' }, () => {
    assert.deepEqual(readLegacyStarredProjectIds(), []);
  });
});

test('clearLegacyStarredProjectIds removes the legacy key', () => {
  withLocalStorage({ starredProjects: JSON.stringify(['a']), keep: '1' }, (store) => {
    clearLegacyStarredProjectIds();
    assert.equal(store.getItem('starredProjects'), null);
    assert.equal(store.getItem('keep'), '1');
  });
});

// ── sortProjects: the date + name branches (count/star live in sortProjects.test) ──

test("sortProjects 'date' mode orders by most-recent session activity", () => {
  const recent = project({
    projectId: 'recent',
    sessions: [session({ id: 'r', lastActivity: '2026-07-01T00:00:00.000Z' })],
  });
  const old = project({
    projectId: 'old',
    sessions: [session({ id: 'o', lastActivity: '2024-01-01T00:00:00.000Z' })],
  });
  const sorted = sortProjects([old, recent], 'date');
  assert.deepEqual(sorted.map((p) => p.projectId), ['recent', 'old']);
});

test("sortProjects 'name' mode orders alphabetically by displayName", () => {
  const projects = [
    project({ projectId: 'c', displayName: 'Charlie' }),
    project({ projectId: 'a', displayName: 'alpha' }),
    project({ projectId: 'b', displayName: 'Bravo' }),
  ];
  const sorted = sortProjects(projects, 'name');
  assert.deepEqual(sorted.map((p) => p.displayName), ['alpha', 'Bravo', 'Charlie']);
});

test('sortProjects does not mutate the input array', () => {
  const projects = [project({ projectId: 'b' }), project({ projectId: 'a' })];
  const original = projects.map((p) => p.projectId);
  sortProjects(projects, 'name');
  assert.deepEqual(projects.map((p) => p.projectId), original);
});
