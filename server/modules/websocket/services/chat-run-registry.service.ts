import path from 'node:path';

import { activeRunsDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import type { PersistRunInput } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  AnyRecord,
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 */
export type ChatRun = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
  /**
   * When the run first entered a blocked/awaiting-input state (a permission
   * prompt or plan-mode approval), else `null`. Surfaced as `blocked` in
   * `listRunningRuns()` so the sidebar ranks a blocked-but-running session as
   * "needs attention". Stored as a timestamp for a future "blocked for Ns"
   * display; today only its presence is read.
   */
  awaitingInputSince: number | null;
  /**
   * Number of tool approvals currently outstanding for the run. A single turn
   * can have several `canUseTool` awaits in flight at once, so blocked state is
   * refcounted: `awaitingInputSince` is stamped when the count goes 0->1 and
   * cleared only when the last approval resolves (count -> 0). A plain boolean
   * would clear early the moment the first of several concurrent approvals
   * resolved, wrongly dropping the run back to "running" while still waiting.
   */
  pendingApprovalCount: number;
  /**
   * Row id of this run's durable `active_runs` journal record (issue #70), or
   * `undefined` for runs created through the test-only `startRun`/`startDispatchedRun`
   * primitives without a persisted message. The registry updates that row's
   * provider id mid-run and deletes it on completion so a clean lifecycle never
   * leaves an interrupted ghost; a restart before completion leaves the row for
   * the startup reconcile to surface as resumable.
   */
  persistId?: number;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * Upper bound on messages held in one session's server-side FIFO queue.
 *
 * Concurrent sends for a session whose run is already in progress are absorbed
 * into this queue instead of being rejected as duplicate runs (which used to
 * silently drop the losing client's message). The cap only guards against a
 * pathological client flooding a single session; on overflow the caller
 * surfaces a *visible* protocol error rather than dropping the message
 * silently.
 */
const MAX_PENDING_MESSAGES_PER_SESSION = 50;

/**
 * A message accepted for a session while a run was already in progress. Held in
 * the server-side FIFO queue and dispatched, in arrival order, as each run
 * completes — so two devices queueing the same session are both delivered
 * instead of the second being rejected and dropped.
 */
export type QueuedChatMessage = {
  content: string;
  options: AnyRecord;
  connection: RealtimeClientConnection;
  userId: string | number | null;
  enqueuedAt: number;
  /**
   * Row id of this message's durable `active_runs` journal record (issue #70),
   * set once it has been persisted as `queued`. The dispatcher promotes that row
   * to `running` when the message leaves the queue, so a restart mid-queue never
   * loses it. `undefined` for messages built by tests that bypass persistence.
   */
  persistId?: number;
};

/** Inputs needed to create (and register) a run for a session. */
type StartRunInput = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  connection: RealtimeClientConnection;
  userId: string | number | null;
};

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

/**
 * Per-session FIFO queue of messages accepted while a run was in progress.
 * Drained by the session's single active dispatcher as each run completes.
 */
const pendingQueues = new Map<string, QueuedChatMessage[]>();

/**
 * Sessions with an active dispatcher — the async task that started the head run
 * and owns draining the pending queue in order. While a session is in this set,
 * a concurrent send must enqueue rather than start a new run, even in the brief
 * gap between one run completing and the next being started. This closes the
 * race where two devices both flush the instant a turn ends.
 */
const dispatchingSessions = new Set<string>();

/**
 * Set once by `beginDrain()` on SIGTERM/SIGINT: the server is shutting down and
 * must stop accepting new runs while it lets in-flight runs finish (issue #70).
 * While draining, `submitMessage` reports `draining` so the caller surfaces a
 * *visible* "retry" error rather than starting a run the imminent exit would
 * guillotine mid-stream. Module-level (not per-session) because a drain applies
 * to the whole process.
 */
let draining = false;

async function broadcastCanonicalSessionUpsert(appSessionId: string): Promise<void> {
  const row = sessionsDb.getSessionById(appSessionId);
  if (!row || row.isArchived) {
    return;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  const payload = JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
      // Carry the Done-state timestamps so a live upsert never wipes them from
      // the client's session row (the sidebar derives Done from these).
      last_completed_at: row.last_completed_at,
      last_viewed_at: row.last_viewed_at,
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

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

function evictRunLater(appSessionId: string): void {
  const timer = setTimeout(() => {
    const run = runs.get(appSessionId);
    if (run && run.status === 'completed') {
      runs.delete(appSessionId);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    evictRunLater(run.appSessionId);

    // Single completion choke point (natural end, abort, and synthetic
    // safety-net all funnel through here): drop the durable journal record so a
    // cleanly-finished run never lingers to be surfaced as interrupted after a
    // later restart (issue #70).
    if (run.persistId != null) {
      try {
        activeRunsDb.remove(run.persistId);
        run.persistId = undefined;
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        console.error('[ChatRunRegistry] Failed to clear active_runs journal on completion', {
          appSessionId: run.appSessionId,
          error: messageText,
        });
      }
    }

    // Persist the finish time so the sidebar can show a durable "Done"
    // (finished-but-unviewed) state that survives reload/eviction, then
    // broadcast the updated row so clients reflect Done live rather than only
    // on the next projects refresh. This is the single completion choke point
    // (natural end, abort, and synthetic safety-net all funnel through here).
    try {
      sessionsDb.setLastCompletedAt(run.appSessionId);
      void broadcastCanonicalSessionUpsert(run.appSessionId).catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        console.error('[ChatRunRegistry] Failed to broadcast Done-state upsert', {
          appSessionId: run.appSessionId,
          error: messageText,
        });
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to persist session completion time', {
        appSessionId: run.appSessionId,
        error: messageText,
      });
    }
  }

  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  return outbound;
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  // Keep the durable journal addressable by the provider-native id so a
  // post-restart resume can continue the provider transcript (issue #70).
  if (run.persistId != null) {
    try {
      activeRunsDb.setProviderSessionId(run.persistId, providerSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to persist provider id to active_runs journal', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    }
  }

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastCanonicalSessionUpsert(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Refcounted block/unblock for a run. `blocked=true` when a `canUseTool`
 * approval starts waiting, `false` when it resolves. `awaitingInputSince` (read
 * as `blocked` in `listRunningRuns()`) is stamped when the first approval
 * begins waiting and cleared only when the last outstanding approval resolves —
 * so a run with two concurrent approvals stays blocked until both are answered,
 * instead of clearing the moment the first one resolves.
 */
function setRunBlocked(run: ChatRun, blocked: boolean): void {
  if (blocked) {
    run.pendingApprovalCount += 1;
    if (run.awaitingInputSince === null) {
      run.awaitingInputSince = Date.now();
    }
    return;
  }

  run.pendingApprovalCount = Math.max(0, run.pendingApprovalCount - 1);
  if (run.pendingApprovalCount === 0) {
    run.awaitingInputSince = null;
  }
}

function logPersistFailure(what: string, appSessionId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ChatRunRegistry] Failed to ${what} in active_runs journal`, { appSessionId, error: message });
}

function toPersistInput(input: StartRunInput, message: QueuedChatMessage): PersistRunInput {
  return {
    sessionId: input.appSessionId,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    content: message.content,
    options: message.options,
    userId: message.userId,
    enqueuedAt: message.enqueuedAt,
  };
}

/**
 * Best-effort durability wrappers for the `active_runs` journal (issue #70). A
 * DB write failure must never break the live send path — the in-memory registry
 * still drives the run; only its post-restart resumability is lost. So these
 * log and return `undefined` instead of throwing.
 */
function persistRunning(input: StartRunInput, message: QueuedChatMessage): number | undefined {
  try {
    return activeRunsDb.recordRunning(toPersistInput(input, message));
  } catch (error) {
    logPersistFailure('record running run', input.appSessionId, error);
    return undefined;
  }
}

function persistQueued(input: StartRunInput, message: QueuedChatMessage): number | undefined {
  try {
    return activeRunsDb.recordQueued(toPersistInput(input, message));
  } catch (error) {
    logPersistFailure('record queued message', input.appSessionId, error);
    return undefined;
  }
}

/**
 * Builds a run, wires its gateway writer, and registers it under the app
 * session id. Callers are responsible for the concurrency decision (whether a
 * run is allowed to start) — this only constructs and registers.
 */
function createAndRegisterRun(input: StartRunInput): ChatRun {
  const run: ChatRun = {
    appSessionId: input.appSessionId,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    status: 'running',
    lastSeq: 0,
    events: [],
    writer: null as unknown as ChatSessionWriter,
    startedAt: Date.now(),
    completedAt: null,
    awaitingInputSince: null,
    pendingApprovalCount: 0,
  };

  run.writer = new ChatSessionWriter({
    connection: input.connection,
    userId: input.userId,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    onProviderSessionId: (providerSessionId) => {
      recordProviderSessionId(run, providerSessionId);
    },
    onBlockedChange: (blocked) => {
      setRunBlocked(run, blocked);
    },
    isRunActive: () => run.status === 'running',
    decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
  });

  runs.set(input.appSessionId, run);
  return run;
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /**
   * Starts tracking a run and returns it, or `null` when the session already
   * has a run in progress OR an active dispatcher draining its queue. The
   * production chat.send path goes through `submitMessage` (which additionally
   * queues rather than rejecting); `startRun` remains as a thin, dispatcher-safe
   * primitive for tests. The dispatcher check matters so that even a direct
   * caller cannot start a second run during the gap between one run completing
   * and the dispatcher pulling the next queued message.
   */
  startRun(input: StartRunInput): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if ((existing && existing.status === 'running') || dispatchingSessions.has(input.appSessionId)) {
      return null;
    }

    return createAndRegisterRun(input);
  },

  /**
   * Single atomic entry point for `chat.send`. Decides — without yielding to
   * the event loop, so two near-simultaneous sends can't both win — whether
   * this message starts a run now or joins the session's FIFO queue:
   *
   * - `start`: no run in progress and no active dispatcher. A run is created
   *   and the session is marked as dispatching; the caller MUST drive the run
   *   to completion and then drain the queue via `takeNextQueued`.
   * - `queued`: a run is in progress (or a dispatcher is mid-handoff between
   *   two runs). The message is appended and the active dispatcher will send
   *   it, in arrival order, when the current run finishes.
   * - `rejected`: the queue is at capacity; the caller surfaces a *visible*
   *   error instead of silently dropping the message.
   */
  submitMessage(
    input: StartRunInput,
    message: QueuedChatMessage,
  ):
    | { action: 'start'; run: ChatRun }
    | { action: 'queued'; queueLength: number }
    | { action: 'rejected' }
    | { action: 'draining' } {
    const sessionId = input.appSessionId;

    // Shutting down: refuse new work rather than starting/queueing a run the
    // imminent process exit would guillotine mid-stream. The caller surfaces a
    // visible "server restarting, retry" error so the message is never silently
    // lost (issue #70).
    if (draining) {
      return { action: 'draining' };
    }

    const runInProgress = runs.get(sessionId)?.status === 'running';

    if (runInProgress || dispatchingSessions.has(sessionId)) {
      const queue = pendingQueues.get(sessionId) ?? [];
      if (queue.length >= MAX_PENDING_MESSAGES_PER_SESSION) {
        return { action: 'rejected' };
      }
      message.persistId = persistQueued(input, message);
      queue.push(message);
      pendingQueues.set(sessionId, queue);
      return { action: 'queued', queueLength: queue.length };
    }

    dispatchingSessions.add(sessionId);
    const run = createAndRegisterRun(input);
    run.persistId = persistRunning(input, message);
    return { action: 'start', run };
  },

  /**
   * Pulls the next queued message for a session, called only by that session's
   * active dispatcher after a run completes. Returns `null` and releases the
   * dispatcher role when the queue is empty — atomically, so a send that
   * arrives *after* this returns null starts a fresh run rather than orphaning
   * a message behind an already-released dispatcher.
   */
  takeNextQueued(appSessionId: string): QueuedChatMessage | null {
    const queue = pendingQueues.get(appSessionId);
    if (!queue || queue.length === 0) {
      pendingQueues.delete(appSessionId);
      dispatchingSessions.delete(appSessionId);
      return null;
    }

    const next = queue.shift() as QueuedChatMessage;
    if (queue.length === 0) {
      pendingQueues.delete(appSessionId);
    }
    return next;
  },

  /**
   * Creates the run for a message just dequeued by the active dispatcher. No
   * arbitration is needed: the dispatcher role is already held and the previous
   * run has completed, so this is unambiguously the session's next run.
   *
   * The dequeued message already owns a durable `queued` journal row; promote it
   * in place to `running` (carrying the provider id resolved by the previous
   * run) rather than inserting a new record, so its journal identity — and thus
   * its resumability — survives the queue-to-run handoff (issue #70).
   */
  startDispatchedRun(input: StartRunInput, message: QueuedChatMessage): ChatRun {
    const run = createAndRegisterRun(input);
    if (message.persistId != null) {
      run.persistId = message.persistId;
      try {
        activeRunsDb.promoteToRunning(message.persistId, input.providerSessionId);
      } catch (error) {
        logPersistFailure('promote queued message to running', input.appSessionId, error);
      }
    }
    return run;
  },

  /**
   * Forcibly releases the dispatcher role and drops any still-queued messages
   * for a session. Reserved for the two abnormal exits the dispatcher loop can
   * hit — an unexpected error mid-drain, or a session deleted out from under a
   * queue — where leaving the session marked as dispatching would wedge it (all
   * future sends absorbed into a queue nobody drains). Returns the number of
   * pending messages discarded, for logging. Normal draining uses
   * `takeNextQueued`, which releases the role on its own when the queue empties.
   */
  releaseDispatcher(appSessionId: string): number {
    const discarded = pendingQueues.get(appSessionId)?.length ?? 0;
    pendingQueues.delete(appSessionId);
    dispatchingSessions.delete(appSessionId);
    // Discard the durable journal rows for this session too, so a forced release
    // (error mid-drain, or a session deleted out from under its queue) doesn't
    // leave orphaned records the startup reconcile would resurrect as
    // interrupted (issue #70).
    try {
      activeRunsDb.removeBySession(appSessionId);
    } catch (error) {
      logPersistFailure('clear discarded journal rows', appSessionId, error);
    }
    return discarded;
  },

  /** Number of messages waiting in a session's server-side FIFO queue. */
  getPendingCount(appSessionId: string): number {
    return pendingQueues.get(appSessionId)?.length ?? 0;
  },

  /** Snapshot of a session's pending queue (test/introspection helper). */
  listPending(appSessionId: string): QueuedChatMessage[] {
    return [...(pendingQueues.get(appSessionId) ?? [])];
  },

  /** Whether a session currently has an active dispatcher draining its queue. */
  isDispatching(appSessionId: string): boolean {
    return dispatchingSessions.has(appSessionId);
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
    blocked: boolean;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
        blocked: run.awaitingInputSince !== null,
      }));
  },

  /**
   * Re-attaches a run's outbound stream to a (new) websocket connection.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.updateWebSocket(connection);
    return true;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used by the dispatch loop's error handler to unwedge a
   * session after an unexpected failure between runs. Paths that hold a
   * reference to a specific run (the runtime safety net, `chat.abort`) use
   * `completeRunIfCurrent` instead so they cannot terminate a newer run.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /** Whether the server has entered shutdown drain (issue #70). */
  isDraining(): boolean {
    return draining;
  },

  /**
   * Enters shutdown-drain mode on SIGTERM/SIGINT: stop accepting new runs so
   * in-flight runs can finish before the process exits. Idempotent.
   */
  beginDrain(): void {
    draining = true;
  },

  /** Number of runs currently streaming (status `running`). */
  countRunningRuns(): number {
    let count = 0;
    for (const run of runs.values()) {
      if (run.status === 'running') {
        count += 1;
      }
    }
    return count;
  },

  /**
   * Resolves once no run is streaming, or after `timeoutMs` — the bounded
   * graceful-drain wait the shutdown handler awaits before exiting. Polls the
   * run map rather than hooking each run's completion so it stays decoupled from
   * the writer path and safe to call from a signal handler. Returns whether the
   * drain fully completed and how many runs were still live at the deadline
   * (those survive as interrupted+resumable via the journal after the restart).
   */
  async waitForActiveRuns(
    timeoutMs: number,
    pollMs = 100,
  ): Promise<{ drained: boolean; remaining: number }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = this.countRunningRuns();
      if (remaining === 0) {
        return { drained: true, remaining: 0 };
      }
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) {
        return { drained: false, remaining };
      }
      // Deliberately NOT unref'd: the shutdown handler awaits this wait, so the
      // poll timer must keep the event loop alive until the drain resolves —
      // otherwise the process could exit before in-flight runs get their window.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(pollMs, timeLeft));
      });
    }
  },

  /**
   * Test-only escape hatch: clears every tracked run and queued message, and
   * resets the drain flag so a drain test cannot leak into later suites.
   */
  clearAll(): void {
    runs.clear();
    pendingQueues.clear();
    dispatchingSessions.clear();
    draining = false;
  },
};
