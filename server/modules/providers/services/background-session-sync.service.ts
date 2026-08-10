import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';

/**
 * Coalesces "make the index fresh" requests into one background scan (#302).
 *
 * `GET /api/projects` serves the persisted SQLite snapshot without awaiting a
 * provider scan, so freshness has to happen off the request path. Every caller
 * that wants fresh data asks here; overlapping asks share the one run, and when
 * it lands with new/changed sessions indexed, connected clients are told to
 * reconcile their snapshot.
 */
let pendingBackgroundSync: Promise<void> | null = null;
// Identifies the run that owns the pending slot, so a run that finishes late
// cannot clear a newer one someone else installed.
let pendingBackgroundSyncId = 0;

/**
 * Tells every connected client its project snapshot may be out of date.
 *
 * Deliberately a signal, not a payload: the scan reports per-provider counts,
 * not the session ids it touched, so there is nothing to build `session_upserted`
 * deltas from. The client answers with one silent `/api/projects` refetch, which
 * now reads straight from SQLite.
 */
function broadcastProjectsSnapshotStale(): void {
  const message = JSON.stringify({
    kind: 'projects_snapshot_stale',
    timestamp: new Date().toISOString(),
  });

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}

/**
 * Starts (or joins) a background provider synchronization.
 *
 * Resolves when the scan this call joined has finished, so callers that do care
 * — server startup, tests — can await it. Request handlers should not.
 */
export function requestBackgroundSessionSynchronization(): Promise<void> {
  if (pendingBackgroundSync) {
    return pendingBackgroundSync;
  }

  pendingBackgroundSyncId += 1;
  const runId = pendingBackgroundSyncId;

  const run = (async () => {
    try {
      const result = await sessionSynchronizerService.synchronizeSessions();
      const processedCount = Object.values(result.processedByProvider).reduce(
        (total, processed) => total + processed,
        0,
      );

      if (processedCount > 0) {
        broadcastProjectsSnapshotStale();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Background session synchronization failed', { error: message });
    } finally {
      if (pendingBackgroundSyncId === runId) {
        pendingBackgroundSync = null;
      }
    }
  })();

  pendingBackgroundSync = run;
  return run;
}
