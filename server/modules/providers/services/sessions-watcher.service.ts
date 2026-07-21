import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { resolveSessionLiveStatus } from '@/modules/providers/services/session-live-status.service.js';
import {
  createSessionUpsertDebouncer,
  type SessionUpsertBatch,
  type WatcherEventType,
} from '@/modules/providers/services/session-upsert-debouncer.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { generateDisplayName } from '@/modules/projects/index.js';

const PROVIDER_WATCH_PATHS: Array<{ provider: LLMProvider; rootPath: string }> = [
  {
    provider: 'claude',
    rootPath: path.join(os.homedir(), '.claude', 'projects'),
  },
  {
    provider: 'codex',
    rootPath: path.join(os.homedir(), '.codex', 'sessions'),
  },
];

const WATCHER_IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/*.tmp',
  '**/*.swp',
  '**/.DS_Store',
];

const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

const watchers: FSWatcher[] = [];

/**
 * Filters watcher events to provider-specific session artifact file types.
 */
function isWatcherTargetFile(_provider: LLMProvider, filePath: string): boolean {
  return filePath.endsWith('.jsonl');
}

/**
 * Builds one `session_upserted` delta event for a provider-native session id.
 *
 * The event carries everything a sidebar needs to upsert the session in place
 * (session summary plus owning-project metadata), so clients never need a full
 * project-list refetch when a transcript file changes on disk. Returns `null`
 * when the id cannot be resolved to an indexed session row.
 */
async function buildSessionUpsertedEvent(updatedProviderSessionId: string): Promise<string | null> {
  const row = sessionsDb.getSessionByProviderSessionId(updatedProviderSessionId)
    ?? sessionsDb.getSessionById(updatedProviderSessionId);
  if (!row || row.isArchived) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  // A transcript write is exactly when a terminal session's live status changes,
  // so recompute it here and carry it on the delta (#21). The client merge keeps
  // existing fields, so a delta that omitted it would leave the row's status
  // stale until the next full /api/projects refresh.
  const liveStatus = await resolveSessionLiveStatus({
    provider: row.provider,
    sessionId: row.session_id,
    jsonlPath: row.jsonl_path ?? null,
    projectPath: row.project_path ?? null,
  });

  return JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
      // Keep in sync with broadcastCanonicalSessionUpsert in
      // chat-run-registry.service.ts — a session first appearing via this
      // disk-watcher path must still carry the Done-state timestamps, else it
      // renders not-Done until the next full /api/projects refresh.
      last_completed_at: row.last_completed_at,
      last_viewed_at: row.last_viewed_at,
      liveStatus,
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Broadcasts a single `session_upserted` delta for one app session id.
 *
 * Reuses the same event shape and client fan-out as the filesystem watcher so
 * out-of-band mutations (e.g. the AI-title worker rewriting `custom_name`) show
 * up in every sidebar immediately, without a full project-list refetch. No-op
 * when the id cannot be resolved to an active session row.
 */
export async function broadcastSessionUpserted(sessionId: string): Promise<void> {
  const event = await buildSessionUpsertedEvent(sessionId);
  if (!event) {
    return;
  }

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(event);
    }
  });
}

/**
 * Builds the `session_upserted` payloads for a batch of session ids, isolating
 * failures per session.
 *
 * Building one event touches the DB and the filesystem (live-status probing),
 * and the batch has already been detached from the debouncer's queue by the time
 * this runs — so a single session throwing must not abort the loop. Doing so used
 * to silently and permanently drop every other session's delta in the same
 * batch. Each id is therefore built in its own try/catch, and only failing ids
 * are dropped (and logged). Exported for its own regression test.
 */
export async function buildResilientSessionEvents(
  sessionIds: Iterable<string>,
  buildEvent: (sessionId: string) => Promise<string | null>,
  onError: (sessionId: string, error: unknown) => void = defaultSessionEventBuildErrorLogger
): Promise<string[]> {
  const events: string[] = [];
  for (const sessionId of sessionIds) {
    try {
      const event = await buildEvent(sessionId);
      if (event) {
        events.push(event);
      }
    } catch (error) {
      onError(sessionId, error);
    }
  }
  return events;
}

function defaultSessionEventBuildErrorLogger(sessionId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Session watcher failed to build a session_upserted event', {
    sessionId,
    error: message,
  });
}

async function broadcastWatcherBatch(batch: SessionUpsertBatch): Promise<void> {
  // Per-session deltas instead of full project snapshots: an upsert of one
  // session can never clobber unrelated client state, so the frontend needs
  // no "suppress updates while a run is active" protection logic.
  const events = await buildResilientSessionEvents(
    batch.updatedSessionIds,
    buildSessionUpsertedEvent
  );

  if (events.length === 0) {
    return;
  }

  connectedClients.forEach(client => {
    if (client.readyState === WS_OPEN_STATE) {
      for (const event of events) {
        client.send(event);
      }
    }
  });
}

const watcherUpdateDebouncer = createSessionUpsertDebouncer({
  debounceMs: PROJECTS_UPDATE_DEBOUNCE_MS,
  maxWaitMs: PROJECTS_UPDATE_MAX_WAIT_MS,
  onFlush: broadcastWatcherBatch,
});

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(provider, filePath);
    if (!result.indexed) {
      return;
    }

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });
    watcherUpdateDebouncer.queue(eventType, provider, result.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 */
export async function initializeSessionsWatcher(): Promise<void> {
  console.log('Setting up session watchers');

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    failures: initialSync.failures,
  });

  for (const { provider, rootPath } of PROVIDER_WATCH_PATHS) {
    try {
      await fsPromises.mkdir(rootPath, { recursive: true });

      const watcher = chokidar.watch(rootPath, {
        ignored: WATCHER_IGNORED_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        depth: 6,
        usePolling: true,
        interval: 6_000,
        binaryInterval: 6_000,
      });

      watcher
        .on('add', (filePath: string) => {
          void onUpdate('add', filePath, provider);
        })
        .on('change', (filePath: string) => {
          void onUpdate('change', filePath, provider);
        })
        .on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Session watcher error for provider "${provider}"`, { error: message });
        });

      watchers.push(watcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  watcherUpdateDebouncer.reset();

  await Promise.all(
    watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.length = 0;
}
