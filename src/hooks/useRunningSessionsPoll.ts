import { useCallback, useEffect } from 'react';

import { api } from '../utils/api';

import type { SyncProcessingSessions } from './useSessionProtection';

/**
 * How often `/api/providers/sessions/running` is re-read while something is
 * worth watching — a run is in flight, or the websocket is down so even the
 * broadcast frames aren't arriving.
 */
export const RUNNING_SESSIONS_ACTIVE_POLL_MS = 5_000;

/**
 * The backed-off cadence for a healthy, idle app: websocket connected and no
 * run in flight. It still discovers a run started from another device or
 * another tab, just without waking the radio every five seconds (#273).
 */
export const RUNNING_SESSIONS_IDLE_POLL_MS = 30_000;

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
  blocked?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
  };
};

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

type UseRunningSessionsPollArgs = {
  /** Applies a fetched snapshot to the app-wide activity map. */
  syncProcessingSessions: SyncProcessingSessions;
  /** True while at least one session is known to be processing. */
  hasRunningSessions: boolean;
  /** Websocket health — a dead socket means nothing else is arriving. */
  isConnected: boolean;
};

/**
 * Keeps the app-wide "which sessions are running" map fresh from
 * `/api/providers/sessions/running`.
 *
 * Why this poll exists at all (re-checked against the websocket in #273): the
 * socket does carry run lifecycle frames — `status` and `complete` — but they
 * go through a `ChatSessionWriter`, whose fan-out set holds only the sockets
 * that started or explicitly subscribed to that run (issue #204). They never
 * reach every client.
 *
 * Three frame kinds *are* broadcast to all `connectedClients`, and none of them
 * carries running/blocked state:
 *   - `session_upserted` (`sessions-watcher` and `chat-run-registry`) — a
 *     transcript row changed on disk;
 *   - `loading_progress` (`projects-with-sessions-fetch`) — project-scan
 *     progress;
 *   - `projects_snapshot_stale` (`background-session-sync`, #302) — a background
 *     provider scan indexed something, so the sidebar snapshot is superseded.
 *
 * So a run started on another device, in another tab, or before this tab loaded
 * is invisible over the socket until this client subscribes to that session —
 * and it can only subscribe to sessions it already believes are running (the
 * reconnect batch in `ChatInterface`, issue #204, reads exactly this output).
 * It is a genuine global discovery mechanism, not a pre-websocket leftover.
 *
 * That reasoning is load-bearing: it is the argument for keeping a poll at all.
 * If you change the broadcast set, re-check it here before concluding the poll
 * is redundant.
 *
 * What it no longer does is run unconditionally: it is gated on tab visibility
 * (a hidden tab issues no requests at all and catches up with a single fetch
 * when it returns) and backs off to {@link RUNNING_SESSIONS_IDLE_POLL_MS} while
 * the socket is healthy and nothing is running.
 */
export function useRunningSessionsPoll({
  syncProcessingSessions,
  hasRunningSessions,
  isConnected,
}: UseRunningSessionsPollArgs): void {
  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
              blocked: typeof session.blocked === 'boolean' ? session.blocked : undefined,
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );
    } catch (error) {
      console.error('[useRunningSessionsPoll] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    let timer: number | null = null;

    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      stop();
      if (document.visibilityState !== 'visible') {
        return;
      }

      const delay = hasRunningSessions || !isConnected
        ? RUNNING_SESSIONS_ACTIVE_POLL_MS
        : RUNNING_SESSIONS_IDLE_POLL_MS;

      timer = window.setInterval(() => {
        void refreshRunningSessions();
      }, delay);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        stop();
        return;
      }

      // Coming back from the background: one immediate fetch stands in for
      // every request the hidden tab skipped.
      void refreshRunningSessions();
      start();
    };

    start();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshRunningSessions, hasRunningSessions, isConnected]);
}
