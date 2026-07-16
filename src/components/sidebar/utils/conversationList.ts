import type { Project } from '../../../types/app';
import type { SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { SessionWithProvider } from '../types/types';

import { getAllSessions, getSessionDate } from './utils';

/**
 * Attention-ranked status for a conversation row in the unified Conversations
 * view. Mirrors the herdr "what needs me now" ordering: a session waiting on the
 * user (`attention`) outranks one actively processing (`running`), which
 * outranks everything dormant (`idle`).
 */
export type ConversationStatus = 'attention' | 'running' | 'idle';

export type ConversationListItem = {
  project: Project;
  session: SessionWithProvider;
  status: ConversationStatus;
  /** Last-activity time in epoch ms; drives the within-status recency sort. */
  activityTime: number;
};

// Lower number sorts first. attention > running > idle.
const STATUS_RANK: Record<ConversationStatus, number> = {
  attention: 0,
  running: 1,
  idle: 2,
};

// Single source of truth for band order: the render layer derives its section
// order from this, so the ranked sort and the on-screen grouping can't disagree.
export const STATUS_ORDER: ConversationStatus[] = (Object.keys(STATUS_RANK) as ConversationStatus[])
  .sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b]);

function resolveStatus(
  sessionId: string,
  activeSessions: SessionActivityMap,
  attentionSessionIds: ReadonlySet<string>,
): ConversationStatus {
  // Attention wins over running: a blocked/finished session the user hasn't
  // looked at yet is more urgent than one still churning.
  if (attentionSessionIds.has(sessionId)) {
    return 'attention';
  }
  if (activeSessions.has(sessionId)) {
    return 'running';
  }
  return 'idle';
}

/**
 * Flatten every project's loaded sessions into a single attention-ranked list.
 *
 * Only the sessions already loaded onto each project are considered (the first
 * page from `/api/projects`), which always includes the recent — i.e. attention
 * and running — sessions. The idle tail of very long projects may be truncated;
 * a dedicated cross-project endpoint would remove that limit (planned follow-up).
 */
export function buildConversationList(
  projects: Project[],
  activeSessions: SessionActivityMap,
  attentionSessionIds: ReadonlySet<string>,
): ConversationListItem[] {
  const items: ConversationListItem[] = [];

  for (const project of projects) {
    for (const session of getAllSessions(project)) {
      const status = resolveStatus(String(session.id), activeSessions, attentionSessionIds);
      items.push({
        project,
        session,
        status,
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
