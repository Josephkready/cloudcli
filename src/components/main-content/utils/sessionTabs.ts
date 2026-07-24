import type { SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { SessionWithProvider } from '../../sidebar/types/types';
import { resolveStatus, type ConversationStatus } from '../../sidebar/utils/conversationList';

export type SessionTabViewModel = {
  id: string;
  isActive: boolean;
  status: ConversationStatus;
  session: SessionWithProvider;
};

/**
 * Maps a space's sessions to the per-space "open sessions" tab-bar view models:
 * which tab is active, and each session's live status (blocked/running/done/recent)
 * via the shared {@link resolveStatus}. Pure so it can be unit-tested without a DOM.
 */
export function buildSessionTabs(
  sessions: SessionWithProvider[],
  activeSessions: SessionActivityMap,
  selectedSessionId: string | null,
): SessionTabViewModel[] {
  return sessions.map((session) => {
    const id = String(session.id);
    return {
      id,
      isActive: selectedSessionId !== null && id === selectedSessionId,
      status: resolveStatus(session, activeSessions, selectedSessionId),
      session,
    };
  });
}

/**
 * Tailwind dot color per status; `null` means no dot is shown (a plain "recent"
 * session that is neither running, blocked, nor finished-unseen).
 */
export const SESSION_TAB_STATUS_DOT: Record<ConversationStatus, string | null> = {
  plan: 'bg-violet-500',
  blocked: 'bg-amber-500',
  running: 'bg-emerald-500',
  done: 'bg-sky-500',
  recent: null,
};

/**
 * Tailwind border color per status, used to outline each session tab in its
 * status color. `recent` gets a transparent border so every pill keeps the same
 * border width (no layout shift) while only status-bearing tabs are tinted.
 */
export const SESSION_TAB_STATUS_BORDER: Record<ConversationStatus, string> = {
  plan: 'border-violet-500',
  blocked: 'border-amber-500',
  running: 'border-emerald-500',
  done: 'border-sky-500',
  recent: 'border-transparent',
};
