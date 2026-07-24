import type { Project } from '../../../types/app';
import type { SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { SessionWithProvider } from '../types/types';

import { getAllSessions, getSessionDate } from './utils';

/**
 * Durable "what needs me now" status for a conversation row. Ordered
 * Plan > Blocked > Done > Running > Recent: an agent that finished a plan and is
 * parked awaiting my review, and one blocked on a permission prompt, both need me
 * before anything else; a plan-approval leads because it's a completed deliverable
 * to act on. Then a run that finished and I haven't looked at, then one still
 * working, then anything old/reviewed. Derived from server-authoritative state
 * (the live `blocked` flag + transcript `liveStatus` + persisted
 * `last_completed_at`/`last_viewed_at`), not a per-tab ephemeral set — so it's the
 * same on every device and survives reload.
 */
export type ConversationStatus = 'plan' | 'blocked' | 'done' | 'running' | 'recent';

export type ConversationListItem = {
  project: Project;
  session: SessionWithProvider;
  status: ConversationStatus;
  /**
   * True while a run is live for this session (running OR blocked-but-running).
   * Distinct from `status` (a blocked run ranks `blocked`, not `running`);
   * consumers that must know "is a run in flight" (e.g. to hide the delete
   * action) key off this, not the ranking band.
   */
  isActive: boolean;
  /** Last-activity time in epoch ms; drives the within-status recency sort. */
  activityTime: number;
};

// Lower number sorts first: Plan > Blocked > Done > Running > Recent.
const STATUS_RANK: Record<ConversationStatus, number> = {
  plan: 0,
  blocked: 1,
  done: 2,
  running: 3,
  recent: 4,
};

// Single source of truth for band order: the render layer derives its section
// order from this, so the ranked sort and the on-screen grouping can't disagree.
export const STATUS_ORDER: ConversationStatus[] = (Object.keys(STATUS_RANK) as ConversationStatus[])
  .sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b]);

/**
 * A session is "Done" when its last run finished after the last time it was
 * viewed (or it was never viewed) — a durable finished-but-unseen signal. The
 * currently-open session is never Done: you're looking at it, so it must not
 * flash Done if a run completes while it's on screen (the persisted
 * `last_viewed_at` catches up on the next open, and the client bumps it
 * optimistically on select).
 */
export function isSessionDone(
  session: SessionWithProvider,
  selectedSessionId: string | null,
): boolean {
  const completed = session.last_completed_at;
  if (!completed) {
    return false;
  }
  if (selectedSessionId !== null && String(session.id) === selectedSessionId) {
    return false;
  }
  const viewed = session.last_viewed_at;
  // Both are canonical ISO strings, so a lexicographic compare is chronological.
  return !viewed || completed > viewed;
}

/**
 * True when the server detected a live run for a session cloudcli didn't launch
 * (a bare-terminal `claude` writing the same transcript, #21). Only meaningful
 * for sessions absent from the client `activeSessions` map — for those cloudcli
 * launched, the client's own live state is authoritative.
 */
function isServerLive(session: SessionWithProvider): boolean {
  return (
    session.liveStatus === 'plan' ||
    session.liveStatus === 'blocked' ||
    session.liveStatus === 'working'
  );
}

export function resolveStatus(
  session: SessionWithProvider,
  activeSessions: SessionActivityMap,
  selectedSessionId: string | null,
): ConversationStatus {
  const sessionId = String(session.id);
  const activeRun = activeSessions.get(sessionId);
  // A live run the server reports as blocked (waiting on a permission prompt or
  // an interaction tool) needs me now — in any tab, regardless of who started
  // it. Distinguish a plan submitted for approval from a generic prompt via the
  // transcript-derived status, which resolved the parked tool's identity. The
  // live `blocked` flag gates this so a stale transcript can't flash "plan" once
  // the run has already resumed.
  if (activeRun?.blocked) {
    return session.liveStatus === 'plan' ? 'plan' : 'blocked';
  }
  // Actively working, no action needed from me.
  if (activeRun) {
    return 'running';
  }
  // No client-side run for this session — cloudcli didn't launch it (or it was
  // reloaded / cleaned up). Fall back to the server's transcript-derived live
  // status so terminal sessions rank alongside cloudcli-driven ones. A plan
  // parked for review, then a generic prompt, both outrank Done.
  if (session.liveStatus === 'plan') {
    return 'plan';
  }
  if (session.liveStatus === 'blocked') {
    return 'blocked';
  }
  // Finished and not yet reviewed.
  if (isSessionDone(session, selectedSessionId)) {
    return 'done';
  }
  // A terminal session still actively working ranks Running, below Done.
  if (session.liveStatus === 'working') {
    return 'running';
  }
  return 'recent';
}

/**
 * Flatten every project's loaded sessions into a single status-ranked list.
 *
 * Only the sessions already loaded onto each project are considered (the first
 * page from `/api/projects`), which always includes the recent — i.e. blocked,
 * done, and running — sessions. The reviewed tail of very long projects may be
 * truncated; a dedicated cross-project endpoint would remove that limit.
 */
export function buildConversationList(
  projects: Project[],
  activeSessions: SessionActivityMap,
  selectedSessionId: string | null,
): ConversationListItem[] {
  const items: ConversationListItem[] = [];

  for (const project of projects) {
    for (const session of getAllSessions(project)) {
      const status = resolveStatus(session, activeSessions, selectedSessionId);
      items.push({
        project,
        session,
        status,
        // A run is in flight if cloudcli launched it (client `activeSessions`) or
        // the server sees the terminal transcript live (working/blocked). Either
        // way the row should suppress destructive actions like delete.
        isActive: activeSessions.has(String(session.id)) || isServerLive(session),
        activityTime: getSessionDate(session).getTime(),
      });
    }
  }

  return items.sort((a, b) => {
    const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rankDiff !== 0) {
      return rankDiff;
    }
    // Newest first within a status band. NaN timestamps (unparseable dates)
    // sink to the bottom of their band rather than scrambling the order.
    const aTime = Number.isNaN(a.activityTime) ? -Infinity : a.activityTime;
    const bTime = Number.isNaN(b.activityTime) ? -Infinity : b.activityTime;
    return bTime - aTime;
  });
}

/**
 * Compact relative age (<1m, Xm, Xhr, Xd) for a conversation row. Shares the
 * format used by the per-project session rows so the two views read the same.
 * Returns '' for non-finite or non-positive timestamps.
 */
export function formatCompactAge(activityTime: number, now: Date): string {
  if (!Number.isFinite(activityTime) || activityTime <= 0) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, now.getTime() - activityTime) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }

  return `${Math.floor(diffInHours / 24)}d`;
}
