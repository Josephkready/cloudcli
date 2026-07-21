import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildConversationList } from '../components/sidebar/utils/conversationList';
import type { Project, ProjectSession } from '../types/app';

import { upsertSessionIntoProject, type SessionUpsertedEvent } from './useProjectsState.pure';
import type { SessionActivity, SessionActivityMap } from './useSessionProtection';

/*
 * Regression lock for #44 / #38: a session's Conversations-list band
 * (Blocked > Done > Running > Recent) is derived only from server-authoritative
 * state — the live `blocked` flag, the persisted `last_completed_at`/
 * `last_viewed_at`, and the transcript-derived `liveStatus`. A stream/tool
 * transcript write (delivered as a `session_upserted` sidebar delta) bumps a
 * row's activity time and summary but must NEVER promote a non-viewed running
 * session into Blocked or Done. The original guards (`attentionEvents.ts`) were
 * deleted with the bands redesign (#65); this pins the invariant end to end
 * across the upsert reducer and the status resolver.
 */

const T0 = '2026-07-21T10:00:00.000Z';
const T1 = '2026-07-21T10:05:00.000Z'; // strictly newer — a fresh transcript write

function projectSession(id: string, extra: Partial<ProjectSession> = {}): ProjectSession {
  return { id, summary: `Session ${id}`, lastActivity: T0, __provider: 'claude', ...extra };
}

function makeProject(sessions: ProjectSession[]): Project {
  return {
    projectId: 'p1',
    displayName: 'P1',
    fullPath: '/repos/p1',
    path: '/repos/p1',
    isStarred: false,
    sessions,
    sessionMeta: { hasMore: false, total: sessions.length },
  };
}

function activity(blocked: boolean): SessionActivity {
  return { statusText: null, canInterrupt: true, startedAt: 0, blocked };
}

function activeMap(entries: Record<string, boolean>): SessionActivityMap {
  return new Map(Object.entries(entries).map(([id, blocked]) => [id, activity(blocked)]));
}

// A `session_upserted` transcript write: exactly what a `stream_delta` /
// `tool_use` flush produces on disk — a fresh `lastActivity` and a tool-ish
// summary, carrying NO server-authoritative status (no `last_completed_at`, no
// blocked flag, no `liveStatus`).
function transcriptWrite(id: string, session: ProjectSession): SessionUpsertedEvent {
  return { kind: 'session_upserted', sessionId: id, provider: 'claude', session, project: null } as SessionUpsertedEvent;
}

function statusOf(project: Project, active: SessionActivityMap, selected: string | null): string {
  return buildConversationList([project], active, selected)[0].status;
}

describe('session status is server-authoritative — transcript/stream events never inflate the band (#44/#38)', () => {
  it('a transcript write leaves a Recent session Recent (not Done, not Blocked)', () => {
    const before = makeProject([projectSession('s1')]);
    assert.equal(statusOf(before, new Map(), null), 'recent');

    const after = upsertSessionIntoProject(
      before,
      transcriptWrite('s1', projectSession('s1', { lastActivity: T1, summary: 'Running Bash: ls -la' })),
    );

    const item = buildConversationList([after], new Map(), null)[0];
    assert.equal(item.status, 'recent', 'a transcript write must not promote a Recent row');
    // Proof the upsert actually applied (recency moved) — the assertion is not vacuous.
    assert.equal(item.activityTime, new Date(T1).getTime());
    assert.equal(item.session.summary, 'Running Bash: ls -la');
  });

  it('a tool_use transcript write leaves a Running (unviewed) session Running (not Blocked, not Done)', () => {
    const active = activeMap({ s1: false });
    const before = makeProject([projectSession('s1')]);
    assert.equal(statusOf(before, active, null), 'running');

    const after = upsertSessionIntoProject(
      before,
      transcriptWrite('s1', projectSession('s1', { lastActivity: T1, summary: 'tool_use: Edit' })),
    );
    assert.equal(statusOf(after, active, null), 'running', 'a tool_use event must not flip Running to Blocked/Done');
  });

  it('only a server last_completed_at promotes to Done — a bare transcript write does not', () => {
    // Control: a transcript write alone does NOT make it Done.
    const write = upsertSessionIntoProject(
      makeProject([projectSession('s1')]),
      transcriptWrite('s1', projectSession('s1', { lastActivity: T1 })),
    );
    assert.equal(statusOf(write, new Map(), null), 'recent');

    // Positive control: the server-authoritative last_completed_at DOES — proving
    // the band can move, just not from a stream/transcript event.
    const done = makeProject([projectSession('s1', { last_completed_at: T1, last_viewed_at: null })]);
    assert.equal(statusOf(done, new Map(), null), 'done');
  });

  it('only a server blocked signal promotes to Blocked — a transcript write does not', () => {
    const base = makeProject([projectSession('s1')]);
    const write = upsertSessionIntoProject(
      base,
      transcriptWrite('s1', projectSession('s1', { lastActivity: T1, summary: 'thinking…' })),
    );
    assert.equal(statusOf(write, new Map(), null), 'recent');

    // Positive controls: server-authoritative blocked signals DO block.
    assert.equal(statusOf(base, activeMap({ s1: true }), null), 'blocked', 'client blocked flag blocks');
    const serverBlocked = makeProject([projectSession('s1', { liveStatus: 'blocked' })]);
    assert.equal(statusOf(serverBlocked, new Map(), null), 'blocked', 'server liveStatus blocks');
  });
});
