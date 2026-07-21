import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Project, ProjectSession } from '../types/app';

import {
  countLoadedProjectSessions,
  getSessionAliasIds,
  getSessionProvider,
  isValidTab,
  mergeExpandedSessionPages,
  mergeProjectSessionPage,
  mergeSessionProviderLists,
  normalizeSessionProvider,
  projectFromRegistration,
  projectsHaveChanges,
  removeSessionFromProject,
  upsertSessionIntoProject,
} from './useProjectsState.pure';
import type { SessionUpsertedEvent } from './useProjectsState.pure';

const session = (id: string, overrides: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  summary: `summary ${id}`,
  lastActivity: '2026-07-21T10:00:00.000Z',
  ...overrides,
});

const project = (overrides: Partial<Project> = {}): Project => ({
  projectId: 'p1',
  displayName: 'Project One',
  fullPath: '/home/dev/p1',
  path: '/home/dev/p1',
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
  ...overrides,
});

const upsertEvent = (overrides: Partial<SessionUpsertedEvent> = {}): SessionUpsertedEvent => ({
  kind: 'session_upserted',
  sessionId: 's1',
  provider: 'claude',
  session: session('s1'),
  project: null,
  ...overrides,
});

const sessionIds = (p: Project): string[] => (p.sessions ?? []).map((s) => s.id);

describe('getSessionProvider / normalizeSessionProvider', () => {
  it('prefers the normalized provider over the raw one', () => {
    assert.equal(getSessionProvider(session('s1', { __provider: 'codex', provider: 'claude' })), 'codex');
  });

  it('falls back to the raw provider, then to claude', () => {
    assert.equal(getSessionProvider(session('s1', { provider: 'codex' })), 'codex');
    assert.equal(getSessionProvider(session('s1')), 'claude');
    assert.equal(getSessionProvider(session('s1', { provider: '   ' as never })), 'claude');
  });

  it('stamps the resolved provider without touching other fields', () => {
    const raw = session('s1', { provider: 'codex', summary: 'keep me' });
    const normalized = normalizeSessionProvider(raw);
    assert.equal(normalized.__provider, 'codex');
    assert.equal(normalized.summary, 'keep me');
    assert.equal(raw.__provider, undefined);
  });
});

describe('projectsHaveChanges', () => {
  const base = [project({ sessions: [session('s1')] })];

  it('is false for a structurally identical snapshot', () => {
    assert.equal(projectsHaveChanges(base, [project({ sessions: [session('s1')] })]), false);
  });

  it('is true when the project count changes', () => {
    assert.equal(projectsHaveChanges(base, [...base, project({ projectId: 'p2' })]), true);
    assert.equal(projectsHaveChanges(base, []), true);
  });

  it('is true when identity fields change', () => {
    assert.equal(projectsHaveChanges(base, [project({ sessions: [session('s1')], projectId: 'other' })]), true);
    assert.equal(projectsHaveChanges(base, [project({ sessions: [session('s1')], displayName: 'Renamed' })]), true);
    assert.equal(projectsHaveChanges(base, [project({ sessions: [session('s1')], fullPath: '/elsewhere' })]), true);
    assert.equal(projectsHaveChanges(base, [project({ sessions: [session('s1')], isStarred: true })]), true);
  });

  it('is true when a session field changes', () => {
    const renamed = [project({ sessions: [session('s1', { summary: 'new title' })] })];
    assert.equal(projectsHaveChanges(base, renamed), true);
  });

  it('is true when session pagination metadata changes', () => {
    const paged = [project({ sessions: [session('s1')], sessionMeta: { hasMore: true, total: 9 } })];
    assert.equal(projectsHaveChanges(base, paged), true);
  });

  it('treats missing and false starred flags as the same', () => {
    const withoutFlag = project({ sessions: [session('s1')] });
    delete withoutFlag.isStarred;
    assert.equal(projectsHaveChanges(base, [withoutFlag]), false);
  });
});

describe('mergeSessionProviderLists', () => {
  it('appends only sessions the base list does not already have', () => {
    const merged = mergeSessionProviderLists(
      [session('s1'), session('s2')],
      [session('s2'), session('s3')],
    );
    assert.deepEqual(merged.map((s) => s.id), ['s1', 's2', 's3']);
  });

  it('keeps the base copy of a duplicated session', () => {
    const merged = mergeSessionProviderLists(
      [session('s1', { summary: 'base' })],
      [session('s1', { summary: 'incoming' })],
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].summary, 'base');
  });

  it('compares ids as strings so numeric ids do not slip through twice', () => {
    const merged = mergeSessionProviderLists(
      [session(7 as unknown as string)],
      [session('7')],
    );
    assert.equal(merged.length, 1);
  });

  it('does not mutate its inputs', () => {
    const base = [session('s1')];
    mergeSessionProviderLists(base, [session('s2')]);
    assert.equal(base.length, 1);
  });
});

describe('mergeExpandedSessionPages', () => {
  it('takes the incoming snapshot when nothing was loaded before', () => {
    const incoming = [project({ sessions: [session('s1')] })];
    assert.equal(mergeExpandedSessionPages([], incoming), incoming);
  });

  it('keeps extra pages the user already scrolled into view', () => {
    const previous = [project({
      sessions: [session('s1'), session('s2'), session('s3')],
      sessionMeta: { hasMore: false, total: 3 },
    })];
    const incoming = [project({ sessions: [session('s1')], sessionMeta: { hasMore: true, total: 3 } })];

    const [merged] = mergeExpandedSessionPages(previous, incoming);
    assert.deepEqual(sessionIds(merged), ['s1', 's2', 's3']);
    assert.equal(merged.sessionMeta?.total, 3);
    assert.equal(merged.sessionMeta?.hasMore, false);
  });

  it('still reports more pages when the merged list is short of the total', () => {
    const previous = [project({ sessions: [session('s1'), session('s2')] })];
    const incoming = [project({ sessions: [session('s1')], sessionMeta: { hasMore: true, total: 10 } })];

    const [merged] = mergeExpandedSessionPages(previous, incoming);
    assert.equal(merged.sessionMeta?.hasMore, true);
    assert.equal(merged.sessionMeta?.total, 10);
  });

  it('prefers the incoming page when the server already returned at least as much', () => {
    const previous = [project({ sessions: [session('s1')] })];
    const incoming = [project({ sessions: [session('s1'), session('s2')] })];
    assert.equal(mergeExpandedSessionPages(previous, incoming)[0], incoming[0]);
  });

  it('passes through projects that are new to this snapshot', () => {
    const previous = [project({ projectId: 'p1', sessions: [session('s1'), session('s2')] })];
    const incoming = [project({ projectId: 'p2', sessions: [] })];
    assert.equal(mergeExpandedSessionPages(previous, incoming)[0], incoming[0]);
  });

  it('drops projects the server no longer returns', () => {
    const previous = [project({ projectId: 'p1' }), project({ projectId: 'gone' })];
    const incoming = [project({ projectId: 'p1' })];
    assert.deepEqual(mergeExpandedSessionPages(previous, incoming).map((p) => p.projectId), ['p1']);
  });
});

describe('mergeProjectSessionPage', () => {
  it('appends the next page and recomputes hasMore', () => {
    const existing = project({ sessions: [session('s1')], sessionMeta: { hasMore: true, total: 3 } });
    const merged = mergeProjectSessionPage(existing, {
      sessions: [session('s2')],
      sessionMeta: { hasMore: true, total: 3 },
    });

    assert.deepEqual(sessionIds(merged), ['s1', 's2']);
    assert.equal(merged.sessionMeta?.hasMore, true);
  });

  it('closes out pagination once every session is loaded', () => {
    const existing = project({ sessions: [session('s1')], sessionMeta: { hasMore: true, total: 2 } });
    const merged = mergeProjectSessionPage(existing, {
      sessions: [session('s2')],
      // The server still claims there is more; the loaded count says otherwise.
      sessionMeta: { hasMore: true, total: 2 },
    });
    assert.equal(merged.sessionMeta?.hasMore, false);
  });

  it('does not re-add a session the list already holds', () => {
    const existing = project({ sessions: [session('s1')], sessionMeta: { hasMore: true, total: 2 } });
    const merged = mergeProjectSessionPage(existing, { sessions: [session('s1')], sessionMeta: { total: 2 } });
    assert.deepEqual(sessionIds(merged), ['s1']);
  });

  it('falls back to the existing total when the page omits one', () => {
    const existing = project({ sessions: [session('s1')], sessionMeta: { hasMore: true, total: 5 } });
    const merged = mergeProjectSessionPage(existing, { sessions: [session('s2')] });
    assert.equal(merged.sessionMeta?.total, 5);
  });

  it('leaves the original project untouched', () => {
    const existing = project({ sessions: [session('s1')], sessionMeta: { hasMore: true, total: 2 } });
    mergeProjectSessionPage(existing, { sessions: [session('s2')], sessionMeta: { total: 2 } });
    assert.deepEqual(sessionIds(existing), ['s1']);
    assert.equal(existing.sessionMeta?.hasMore, true);
  });
});

describe('getSessionAliasIds', () => {
  it('collects every id the same session can be known by', () => {
    const ids = getSessionAliasIds(upsertEvent({
      sessionId: 's1',
      providerSessionId: 'provider-abc',
      session: session('legacy-id'),
    }));
    assert.deepEqual([...ids].sort(), ['legacy-id', 'provider-abc', 's1']);
  });

  it('skips blank, whitespace-only and non-string ids', () => {
    const ids = getSessionAliasIds(upsertEvent({
      sessionId: 's1',
      providerSessionId: '   ',
      session: session(42 as unknown as string),
    }));
    assert.deepEqual([...ids], ['s1']);
  });

  it('trims surrounding whitespace', () => {
    const ids = getSessionAliasIds(upsertEvent({ sessionId: '  s1  ', session: session('s1') }));
    assert.deepEqual([...ids], ['s1']);
  });
});

describe('upsertSessionIntoProject', () => {
  it('prepends a brand new session and grows the total', () => {
    const existing = project({ sessions: [session('s1')], sessionMeta: { hasMore: false, total: 1 } });
    const next = upsertSessionIntoProject(existing, upsertEvent({ sessionId: 's2', session: session('s2') }));

    assert.deepEqual(sessionIds(next), ['s2', 's1']);
    assert.equal(next.sessionMeta?.total, 2);
    assert.equal(next.sessionMeta?.hasMore, false);
  });

  it('updates an existing row in place without moving or recounting it', () => {
    const existing = project({
      sessions: [session('s1'), session('s2')],
      sessionMeta: { hasMore: false, total: 2 },
    });
    const next = upsertSessionIntoProject(existing, upsertEvent({
      sessionId: 's2',
      session: session('s2', { summary: 'renamed' }),
    }));

    assert.deepEqual(sessionIds(next), ['s1', 's2']);
    assert.equal(next.sessions?.[1].summary, 'renamed');
    assert.equal(next.sessionMeta?.total, 2);
  });

  it('returns the same object when nothing actually changed', () => {
    const existing = project({
      sessions: [session('s1', { __provider: 'claude' })],
      sessionMeta: { hasMore: false, total: 1 },
    });
    const next = upsertSessionIntoProject(existing, upsertEvent({
      sessionId: 's1',
      session: session('s1'),
    }));
    assert.equal(next, existing);
  });

  it('never blanks an existing title with an empty broadcast summary', () => {
    const existing = project({
      sessions: [session('s1', { summary: 'Real title', __provider: 'claude' })],
      sessionMeta: { hasMore: false, total: 1 },
    });
    const next = upsertSessionIntoProject(existing, upsertEvent({
      sessionId: 's1',
      session: session('s1', { summary: '   ' }),
    }));
    assert.equal(next.sessions?.[0].summary, 'Real title');
  });

  it('collapses alias rows for one session into a single entry', () => {
    // The provider id and the cloudcli id can both be sitting in the list; the
    // upsert has to leave exactly one row behind.
    const existing = project({
      sessions: [session('provider-abc'), session('s1'), session('other')],
      sessionMeta: { hasMore: false, total: 3 },
    });
    const next = upsertSessionIntoProject(existing, upsertEvent({
      sessionId: 's1',
      providerSessionId: 'provider-abc',
      session: session('s1', { summary: 'merged' }),
    }));

    assert.deepEqual(sessionIds(next), ['s1', 'other']);
    assert.equal(next.sessions?.[0].summary, 'merged');
  });

  it('re-stamps the provider of the upserted row', () => {
    const existing = project({ sessions: [], sessionMeta: { hasMore: false, total: 0 } });
    const next = upsertSessionIntoProject(existing, upsertEvent({
      sessionId: 's1',
      provider: 'codex',
      session: session('s1'),
    }));
    assert.equal(next.sessions?.[0].__provider, 'codex');
    assert.equal(next.sessions?.[0].id, 's1');
  });

  it('keeps hasMore true when the project still has unloaded pages', () => {
    const existing = project({ sessions: [session('s1')], sessionMeta: { hasMore: true, total: 40 } });
    const next = upsertSessionIntoProject(existing, upsertEvent({ sessionId: 's2', session: session('s2') }));
    assert.equal(next.sessionMeta?.total, 41);
    assert.equal(next.sessionMeta?.hasMore, true);
  });

  it('leaves the source project untouched', () => {
    const existing = project({ sessions: [session('s1')], sessionMeta: { hasMore: false, total: 1 } });
    upsertSessionIntoProject(existing, upsertEvent({ sessionId: 's2', session: session('s2') }));
    assert.deepEqual(sessionIds(existing), ['s1']);
    assert.equal(existing.sessionMeta?.total, 1);
  });
});

describe('removeSessionFromProject', () => {
  it('removes the row and shrinks the total', () => {
    const existing = project({
      sessions: [session('s1'), session('s2')],
      sessionMeta: { hasMore: false, total: 2 },
    });
    const next = removeSessionFromProject(existing, 's1');
    assert.deepEqual(sessionIds(next), ['s2']);
    assert.equal(next.sessionMeta?.total, 1);
    assert.equal(next.sessionMeta?.hasMore, false);
  });

  it('returns the same object when the session is not in this project', () => {
    const existing = project({ sessions: [session('s1')], sessionMeta: { hasMore: false, total: 1 } });
    assert.equal(removeSessionFromProject(existing, 'nope'), existing);
  });

  it('never drives the total below zero', () => {
    const existing = project({ sessions: [session('s1')], sessionMeta: { hasMore: false, total: 0 } });
    assert.equal(removeSessionFromProject(existing, 's1').sessionMeta?.total, 0);
  });

  it('keeps hasMore true while unloaded pages remain', () => {
    const existing = project({ sessions: [session('s1')], sessionMeta: { hasMore: true, total: 40 } });
    const next = removeSessionFromProject(existing, 's1');
    assert.equal(next.sessionMeta?.total, 39);
    assert.equal(next.sessionMeta?.hasMore, true);
  });

  it('leaves the source project untouched', () => {
    const existing = project({
      sessions: [session('s1'), session('s2')],
      sessionMeta: { hasMore: false, total: 2 },
    });
    removeSessionFromProject(existing, 's1');
    assert.deepEqual(sessionIds(existing), ['s1', 's2']);
  });

  it('round-trips with upsert back to the original list', () => {
    const start = project({ sessions: [session('s1')], sessionMeta: { hasMore: false, total: 1 } });
    const added = upsertSessionIntoProject(start, upsertEvent({ sessionId: 's2', session: session('s2') }));
    const removed = removeSessionFromProject(added, 's2');
    assert.deepEqual(sessionIds(removed), ['s1']);
    assert.equal(removed.sessionMeta?.total, 1);
  });
});

describe('projectFromRegistration', () => {
  it('fills path and fullPath from whichever one is present', () => {
    const fromPathOnly = projectFromRegistration({
      projectId: 'p1',
      displayName: 'One',
      fullPath: '',
      path: '/home/dev/p1',
    });
    assert.equal(fromPathOnly.path, '/home/dev/p1');
    assert.equal(fromPathOnly.fullPath, '/home/dev/p1');

    const fromFullPathOnly = projectFromRegistration({
      projectId: 'p1',
      displayName: 'One',
      fullPath: '/home/dev/p1',
    });
    assert.equal(fromFullPathOnly.path, '/home/dev/p1');
  });

  it('seeds session metadata from the loaded sessions when none is given', () => {
    const seeded = projectFromRegistration({
      projectId: 'p1',
      displayName: 'One',
      fullPath: '/p1',
      sessions: [session('s1'), session('s2')],
    });
    assert.deepEqual(seeded.sessionMeta, { hasMore: false, total: 2 });
  });

  it('drops fields that are not part of the sidebar shape', () => {
    const trimmed = projectFromRegistration(project({ somethingElse: 'noise' }));
    assert.equal('somethingElse' in trimmed, false);
  });
});

describe('countLoadedProjectSessions', () => {
  it('treats a project with no session array as empty', () => {
    assert.equal(countLoadedProjectSessions(project({ sessions: undefined })), 0);
    assert.equal(countLoadedProjectSessions(project({ sessions: [session('s1')] })), 1);
  });
});

describe('isValidTab', () => {
  it('accepts the built-in tabs and plugin tabs', () => {
    for (const tab of ['chat', 'files', 'shell', 'git', 'plugin:anything']) {
      assert.equal(isValidTab(tab), true, tab);
    }
  });

  it('rejects anything else', () => {
    for (const tab of ['', 'CHAT', 'settings', 'plugin']) {
      assert.equal(isValidTab(tab), false, tab);
    }
  });
});
