import {
  sessionSynchronizerService,
  type SessionSynchronizeResult,
} from '@/modules/providers/services/session-synchronizer.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { GatewayEventKind } from '@/shared/types.js';

/**
 * Coalesces "make the index fresh" requests into one background scan (#302).
 *
 * `GET /api/projects` serves the persisted SQLite snapshot without awaiting a
 * provider scan, so freshness has to happen off the request path. Every caller
 * that wants fresh data asks here; overlapping asks share the one run, and when
 * it lands with new/changed sessions indexed, connected clients are told to
 * reconcile their snapshot.
 */
let pendingBackgroundSync: Promise<SessionSynchronizeResult | null> | null = null;
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
  // Typed against the gateway union so the frame kind stays in the one place
  // that documents itself as the complete set a client can receive.
  const frame: { kind: GatewayEventKind; timestamp: string } = {
    kind: 'projects_snapshot_stale',
    timestamp: new Date().toISOString(),
  };
  const message = JSON.stringify(frame);

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}

/**
 * Starts (or joins) a background provider synchronization.
 *
 * Resolves with the scan's result when the run this call joined has finished, so
 * callers that do care — server startup logging, tests — can await it. Request
 * handlers should not. Resolves with `null` if the scan threw, because a caller
 * awaiting a *background* refresh must never inherit its failure.
 */
export function requestBackgroundSessionSynchronization(): Promise<SessionSynchronizeResult | null> {
  if (pendingBackgroundSync) {
    return pendingBackgroundSync;
  }

  pendingBackgroundSyncId += 1;
  const runId = pendingBackgroundSyncId;

  const run = (async (): Promise<SessionSynchronizeResult | null> => {
    try {
      const result = await sessionSynchronizerService.synchronizeSessions();
      const processedCount = Object.values(result.processedByProvider).reduce(
        (total, processed) => total + processed,
        0,
      );

      // Logged on every completed run, including the no-op. "Indexed nothing"
      // and "never ran" are different cold-start failures (#302) and they look
      // identical from the outside, so silence on the zero path would leave the
      // one diagnostic question this feature raises unanswerable.
      console.log('Background session synchronization complete', {
        processedByProvider: result.processedByProvider,
        failures: result.failures,
      });

      if (processedCount > 0) {
        broadcastProjectsSnapshotStale();
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Background session synchronization failed', { error: message });
      return null;
    } finally {
      if (pendingBackgroundSyncId === runId) {
        pendingBackgroundSync = null;
      }
    }
  })();

  pendingBackgroundSync = run;
  return run;
}
