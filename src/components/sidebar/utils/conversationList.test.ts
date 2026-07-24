import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../../types/app';
import type { SessionActivity, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { SessionWithProvider } from '../types/types';

import { buildConversationList, formatCompactAge, isSessionDone } from './conversationList';

function session(id: string, lastActivity: string, extra: Partial<SessionWithProvider> = {}): SessionWithProvider {
  return { id, summary: id, lastActivity, __provider: 'claude', ...extra };
}

function project(projectId: string, sessions: SessionWithProvider[]): Project {
  return { projectId, displayName: projectId, fullPath: `/repos/${projectId}`, sessions };
}

function activity(blocked: boolean): SessionActivity {
  return { statusText: null, canInterrupt: true, startedAt: 0, blocked };
}

function activeSessions(...ids: string[]): SessionActivityMap {
  return new Map(ids.map((id) => [id, activity(false)]));
}

function blockedSessions(...ids: string[]): SessionActivityMap {
  return new Map(ids.map((id) => [id, activity(true)]));
}

// Completed after the given viewed time (or never viewed) => Done.
function completed(at: string, viewedAt?: string): Partial<SessionWithProvider> {
  return { last_completed_at: at, last_viewed_at: viewedAt ?? null };
}

test('ranks blocked > done > running > recent regardless of recency', () => {
  // The recent row is the newest, yet its band sinks it below the older
  // blocked/done/running rows — status dominates recency.
  const p = project('p1', [
    session('s-recent', '2026-07-18T05:00:00Z'),
    session('s-running', '2026-07-18T04:00:00Z'),
    session('s-done', '2026-07-18T03:00:00Z', completed('2026-07-18T03:00:00.000Z')),
    session('s-blocked', '2026-07-18T02:00:00Z'),
  ]);

  const active = new Map([...activeSessions('s-running'), ...blockedSessions('s-blocked')]);
  const list = buildConversationList([p], active, null);

  assert.deepEqual(list.map((item) => item.session.id), ['s-blocked', 's-done', 's-running', 's-recent']);
  assert.deepEqual(list.map((item) => item.status), ['blocked', 'done', 'running', 'recent']);
});

test('isSessionDone: completed after last viewed (or never viewed) is Done', () => {
  assert.equal(isSessionDone(session('s', 'x', completed('2026-07-18T03:00:00.000Z')), null), true);
  assert.equal(
    isSessionDone(session('s', 'x', completed('2026-07-18T03:00:00.000Z', '2026-07-18T02:00:00.000Z')), null),
    true,
  );
  // Viewed AFTER it completed → reviewed, not Done.
  assert.equal(
    isSessionDone(session('s', 'x', completed('2026-07-18T03:00:00.000Z', '2026-07-18T04:00:00.000Z')), null),
    false,
  );
  // Never completed → not Done.
  assert.equal(isSessionDone(session('s', 'x'), null), false);
});

test('the currently-open session is never Done (no flash while viewing)', () => {
  const s = session('s', 'x', completed('2026-07-18T03:00:00.000Z'));
  assert.equal(isSessionDone(s, 's'), false);
  assert.equal(isSessionDone(s, 'other'), true);
});

test('buildConversationList forwards the selected id (selected session ranks Recent, not Done)', () => {
  // Exercises the integration path resolveStatus -> isSessionDone: a wiring bug
  // that dropped selectedSessionId would let the open session show Done here.
  const p = project('p1', [session('s-open', '2026-07-18T03:00:00Z', completed('2026-07-18T03:00:00.000Z'))]);

  assert.equal(buildConversationList([p], new Map(), 's-open')[0].status, 'recent');
  assert.equal(buildConversationList([p], new Map(), 'other')[0].status, 'done');
});

test('an active session is Running/Blocked, not Done, despite an old completion', () => {
  const p = project('p1', [session('s', 'x', completed('2026-07-18T01:00:00.000Z'))]);

  assert.equal(buildConversationList([p], activeSessions('s'), null)[0].status, 'running');
  assert.equal(buildConversationList([p], blockedSessions('s'), null)[0].status, 'blocked');
});

test('isActive is true for running and blocked, false for done and recent', () => {
  const p = project('p1', [
    session('s-run', 'x'),
    session('s-blk', 'x'),
    session('s-done', 'x', completed('2026-07-18T01:00:00.000Z')),
    session('s-rec', 'x'),
  ]);
  const active = new Map([...activeSessions('s-run'), ...blockedSessions('s-blk')]);
  const byId = Object.fromEntries(buildConversationList([p], active, null).map((item) => [item.session.id, item]));

  assert.equal(byId['s-run'].isActive, true);
  assert.equal(byId['s-blk'].isActive, true);
  assert.equal(byId['s-done'].isActive, false);
  assert.equal(byId['s-rec'].isActive, false);
});

// --- Server-detected live status for terminal sessions cloudcli didn't launch (#21) ---

test('server liveStatus "working" ranks a terminal session Running above idle rows', () => {
  const p = project('p1', [
    session('idle-newer', '2026-07-18T05:00:00Z'),
    session('term-working', '2026-07-18T04:00:00Z', { liveStatus: 'working' }),
  ]);

  const list = buildConversationList([p], new Map(), null);

  assert.deepEqual(list.map((item) => item.session.id), ['term-working', 'idle-newer']);
  assert.deepEqual(list.map((item) => item.status), ['running', 'recent']);
});

test('server liveStatus "blocked" ranks a terminal session at the top (needs attention)', () => {
  const p = project('p1', [
    session('running', '2026-07-18T05:00:00Z', { liveStatus: 'working' }),
    session('blocked', '2026-07-18T04:00:00Z', { liveStatus: 'blocked' }),
  ]);

  const list = buildConversationList([p], new Map(), null);

  assert.deepEqual(list.map((item) => item.session.id), ['blocked', 'running']);
  assert.deepEqual(list.map((item) => item.status), ['blocked', 'running']);
});

test('server liveStatus "plan" ranks a terminal session at the very top (plan ready to review)', () => {
  const p = project('p1', [
    session('blocked', '2026-07-18T05:00:00Z', { liveStatus: 'blocked' }),
    session('plan', '2026-07-18T04:00:00Z', { liveStatus: 'plan' }),
  ]);

  const list = buildConversationList([p], new Map(), null);

  // Plan outranks Blocked despite being older.
  assert.deepEqual(list.map((item) => item.session.id), ['plan', 'blocked']);
  assert.deepEqual(list.map((item) => item.status), ['plan', 'blocked']);
});

test('a live run blocked on a plan resolves to plan; blocked without a plan stays blocked', () => {
  // Live run reports blocked AND the transcript identifies the parked tool as a plan.
  const planned = project('p1', [session('s', 'x', { liveStatus: 'plan' })]);
  assert.equal(buildConversationList([planned], blockedSessions('s'), null)[0].status, 'plan');

  // Blocked live run with no plan signal (generic permission prompt) stays blocked.
  const generic = project('p2', [session('s', 'x', { liveStatus: 'blocked' })]);
  assert.equal(buildConversationList([generic], blockedSessions('s'), null)[0].status, 'blocked');
});

test('a live (non-blocked) run ignores a stale transcript "plan" and ranks running', () => {
  // The run resumed after approval but the transcript scan hasn't refreshed yet:
  // the live-run flag (not the stale liveStatus) decides, so it must not flash plan.
  const p = project('p1', [session('s', 'x', { liveStatus: 'plan' })]);
  assert.equal(buildConversationList([p], activeSessions('s'), null)[0].status, 'running');
});

test('isActive is true for a plan-parked terminal session', () => {
  const p = project('p1', [session('s-plan', 'x', { liveStatus: 'plan' })]);
  assert.equal(buildConversationList([p], new Map(), null)[0].isActive, true);
});

test('client-driven status wins over server liveStatus (no regression for cloudcli runs)', () => {
  // Server says idle, but cloudcli has a live run → the client state is authoritative.
  const p = project('p1', [session('s', 'x', { liveStatus: 'idle' })]);
  assert.equal(buildConversationList([p], activeSessions('s'), null)[0].status, 'running');

  // Client blocked outranks a server "working".
  const p2 = project('p2', [session('s', 'x', { liveStatus: 'working' })]);
  assert.equal(buildConversationList([p2], blockedSessions('s'), null)[0].status, 'blocked');

  // A live (non-blocked) client run short-circuits before the server "blocked"
  // check is ever reached — locks in the check order so a reorder can't regress it.
  const p3 = project('p3', [session('s', 'x', { liveStatus: 'blocked' })]);
  assert.equal(buildConversationList([p3], activeSessions('s'), null)[0].status, 'running');
});

test('server "blocked" outranks Done, but Done outranks server "working"', () => {
  const blockedDone = session('bd', 'x', { liveStatus: 'blocked', ...completed('2026-07-18T03:00:00.000Z') });
  assert.equal(buildConversationList([project('p', [blockedDone])], new Map(), null)[0].status, 'blocked');

  const workingDone = session('wd', 'x', { liveStatus: 'working', ...completed('2026-07-18T03:00:00.000Z') });
  assert.equal(buildConversationList([project('p', [workingDone])], new Map(), null)[0].status, 'done');
});

test('isActive reflects server live status for terminal sessions', () => {
  const p = project('p1', [
    session('s-working', 'x', { liveStatus: 'working' }),
    session('s-blocked', 'x', { liveStatus: 'blocked' }),
    session('s-idle', 'x', { liveStatus: 'idle' }),
  ]);
  const byId = Object.fromEntries(buildConversationList([p], new Map(), null).map((item) => [item.session.id, item]));

  assert.equal(byId['s-working'].isActive, true);
  assert.equal(byId['s-blocked'].isActive, true);
  assert.equal(byId['s-idle'].isActive, false);
});

test('sorts newest first within a status band', () => {
  const p = project('p1', [
    session('older', '2026-07-17T00:00:00Z'),
    session('newer', '2026-07-18T00:00:00Z'),
  ]);

  const list = buildConversationList([p], new Map(), null);

  assert.deepEqual(list.map((item) => item.session.id), ['newer', 'older']);
});

test('flattens across projects and ranks globally', () => {
  const projectA = project('A', [session('a-recent', '2026-07-18T05:00:00Z')]);
  const projectB = project('B', [
    session('b-done', '2026-07-10T00:00:00Z', completed('2026-07-10T00:00:00.000Z')),
    session('b-run', '2026-07-11T00:00:00Z'),
  ]);

  const list = buildConversationList([projectA, projectB], activeSessions('b-run'), null);

  assert.deepEqual(list.map((item) => item.session.id), ['b-done', 'b-run', 'a-recent']);
  assert.equal(list[0].project.projectId, 'B');
});

test('returns an empty list when there are no sessions', () => {
  assert.deepEqual(buildConversationList([], new Map(), null), []);
  assert.deepEqual(buildConversationList([project('p', [])], new Map(), null), []);
});

test('sinks sessions with an unparseable timestamp to the bottom of their band', () => {
  const p = project('p1', [
    session('valid', '2026-07-18T00:00:00Z'),
    session('bad', 'not-a-date'),
  ]);

  const list = buildConversationList([p], new Map(), null);

  assert.deepEqual(list.map((item) => item.session.id), ['valid', 'bad']);
});

test('formatCompactAge renders compact relative ages across each band', () => {
  const now = new Date('2026-07-16T12:00:00Z');
  const at = (iso: string) => new Date(iso).getTime();

  assert.equal(formatCompactAge(at('2026-07-16T11:59:30Z'), now), '<1m');
  assert.equal(formatCompactAge(at('2026-07-16T11:45:00Z'), now), '15m');
  assert.equal(formatCompactAge(at('2026-07-16T09:00:00Z'), now), '3hr');
  assert.equal(formatCompactAge(at('2026-07-14T12:00:00Z'), now), '2d');
});

test('formatCompactAge returns empty for invalid or non-positive input', () => {
  const now = new Date('2026-07-16T12:00:00Z');

  assert.equal(formatCompactAge(NaN, now), '');
  assert.equal(formatCompactAge(0, now), '');
  assert.equal(formatCompactAge(-1, now), '');
  assert.equal(formatCompactAge(now.getTime() + 60_000, now), '<1m');
});
