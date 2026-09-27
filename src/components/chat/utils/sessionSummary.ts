/**
 * Pure label-building for the "message sent" notification (the OS
 * notification/title shown while a run is in flight elsewhere). Extracted
 * from `useChatComposerState` so the truncation/fallback rules are
 * unit-testable without React or a `ProjectSession`.
 */

const SUMMARY_MAX_LENGTH = 80;

function truncate(text: string): string {
  return text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH - 3)}...` : text;
}

type SessionLike = {
  summary?: string | null;
  name?: string | null;
  title?: string | null;
} | null | undefined;

/**
 * Prefers the session's own summary/name/title; falls back to the message
 * being sent (for a brand-new session that has none yet). Returns `null`
 * when neither yields anything to show.
 */
export function getNotificationSessionSummary(selectedSession: SessionLike, fallbackInput: string): string | null {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    return truncate(sessionSummary.replace(/\s+/g, ' ').trim());
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return truncate(normalizedFallback);
}
