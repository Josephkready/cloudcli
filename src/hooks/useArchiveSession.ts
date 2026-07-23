import { useCallback } from 'react';

import { api } from '../utils/api';

/**
 * Shared soft-archive for a single session.
 *
 * A non-force `DELETE /api/providers/sessions/:id` archives (`isArchived = 1`)
 * instead of removing the row, so archiving is always safe/recoverable and needs
 * no confirmation dialog. This lives in one place so every entry point — the
 * sidebar row/context menu and the chat view's header button — hits the same
 * endpoint and the same error handling.
 */

/**
 * Narrow view of i18next's `t`: key + required fallback. Keeping the fallback
 * required is what lets an i18next `TFunction` be passed straight in.
 */
type Translate = (key: string, fallback: string) => string;

export type ArchiveSessionDeps = {
  t: Translate;
  /** Called after a successful archive so the caller can drop/deselect the session. */
  onSessionDelete?: (sessionId: string) => void;
  /** Called after a successful archive so the caller can refresh archive-derived state. */
  onArchived?: () => Promise<void> | void;
  /** Injectable for tests. */
  deleteSession?: (sessionId: string, hardDelete: boolean) => Promise<Response>;
  /** Injectable for tests. */
  notifyError?: (message: string) => void;
};

/** Returns `true` when the session was archived. */
export async function archiveSessionRequest(
  sessionId: string,
  { t, onSessionDelete, onArchived, deleteSession, notifyError }: ArchiveSessionDeps,
): Promise<boolean> {
  const request = deleteSession ?? ((id: string, hardDelete: boolean) => api.deleteSession(id, hardDelete));
  const notify =
    notifyError ??
    ((message: string) => {
      if (typeof globalThis.alert === 'function') {
        globalThis.alert(message);
      }
    });

  try {
    const response = await request(sessionId, false);

    if (response.ok) {
      onSessionDelete?.(sessionId);
      await onArchived?.();
      return true;
    }

    const errorText = await response.text();
    console.error('[archiveSession] Failed to archive session:', {
      status: response.status,
      error: errorText,
    });
    notify(t('messages.archiveSessionFailed', 'Failed to archive session. Please try again.'));
    return false;
  } catch (error) {
    console.error('[archiveSession] Error archiving session:', error);
    notify(t('messages.archiveSessionError', 'Error archiving session. Please try again.'));
    return false;
  }
}

export function useArchiveSession({ t, onSessionDelete, onArchived }: {
  t: Translate;
  onSessionDelete?: (sessionId: string) => void;
  onArchived?: () => Promise<void> | void;
}) {
  return useCallback(
    async (sessionId: string) => {
      await archiveSessionRequest(sessionId, { t, onSessionDelete, onArchived });
    },
    [onArchived, onSessionDelete, t],
  );
}
