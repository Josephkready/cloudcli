import path from 'node:path';

import type { WebSocket } from 'ws';

import { activeRunsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import type { ChatRun, QueuedChatMessage } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { getGlobalImageAssetsDir, normalizeImageDescriptors } from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
} from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterImagesToUploadStore(images: unknown, assetsRootOverride?: string): AnyRecord[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeImageDescriptors(images).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping image outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/**
 * One provider runtime entry point. All five runtimes share this signature,
 * which lets the chat handler dispatch through a provider-keyed map instead
 * of provider-specific branches.
 */
type ProviderSpawnFn = (
  command: string,
  options: AnyRecord,
  writer: unknown
) => Promise<unknown>;

type ChatWebSocketDependencies = {
  /** Provider runtimes keyed by provider id. */
  spawnFns: Record<LLMProvider, ProviderSpawnFn>;
  /**
   * Abort functions keyed by provider id. They are addressed with the
   * provider-native session id (that is how runtimes key their process maps).
   * The Claude abort is async; the rest are sync — both shapes are accepted.
   */
  abortFns: Record<LLMProvider, (providerSessionId: string) => boolean | Promise<boolean>>;
  resolveToolApproval: (
    requestId: string,
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
    }
  ) => void;
  /** Claude-only today: pending tool approvals included in `chat_subscribed`. */
  getPendingApprovalsForSession: (providerSessionId: string) => unknown[];
};

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Runs one message through its provider runtime and guarantees the terminal
 * `complete` (via the finally safety net). The session row is read fresh on
 * every call so a dispatched follow-up resumes the provider-native id that the
 * previous run established, and so a mid-queue session deletion is handled.
 */
async function driveSingleRun(
  sessionId: string,
  run: ChatRun,
  message: QueuedChatMessage,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  // Everything is wrapped so this function NEVER throws: the `finally` always
  // emits the run's terminal `complete`, and the outer `catch` swallows any
  // pre-spawn failure (a DB read, image validation) so the dispatcher loop is
  // never torn down with the session still marked as running/dispatching.
  try {
    const session = sessionsDb.getSessionById(sessionId);
    const spawnFn = dependencies.spawnFns[run.provider];
    if (!session || !spawnFn) {
      // Session vanished mid-queue or provider unavailable: end the run cleanly
      // rather than spawning against a missing session.
      console.warn('[Chat] Skipping run: session or provider unavailable', {
        sessionId,
        provider: run.provider,
        hasSession: Boolean(session),
      });
      return;
    }

    const clientOptions = message.options;

    // The provider runtimes receive the provider-native session id (that is the
    // id their CLI/SDK understands for resume). Brand-new sessions have no
    // provider id yet, so the runtime starts fresh and announces one, which the
    // gateway writer captures and maps back to the app session id.
    const runtimeOptions: AnyRecord = {
      ...clientOptions,
      // Image attachments are re-validated server-side: only files inside the
      // global upload store may reach the provider runtimes' file reads.
      images: filterImagesToUploadStore(clientOptions.images),
      sessionId: session.provider_session_id ?? undefined,
      resume: Boolean(session.provider_session_id),
      cwd: clientOptions.cwd ?? session.project_path ?? undefined,
      projectPath: session.project_path ?? clientOptions.projectPath,
    };

    try {
      await spawnFn(message.content, runtimeOptions, run.writer);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Chat] Provider runtime "${run.provider}" failed`, { sessionId, error: errorMessage });
    }
  } catch (error) {
    // Non-spawn failure (session lookup, image validation): log and fall through
    // to the finally, which still completes the run so no client is left stuck.
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[Chat] Failed to dispatch run', { sessionId, provider: run.provider, error: errorMessage });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }
}

/**
 * Server-side per-session FIFO queue drain. Drives the head run to completion,
 * then dispatches every message that queued for the session while runs were in
 * flight — in arrival order — until the queue empties. This is what guarantees
 * that two devices flushing the instant a turn ends are both delivered (A then
 * B) instead of the second being rejected and silently dropped.
 *
 * Only one dispatcher runs per session (the async task that started the head
 * run and holds the dispatcher role in the registry). `takeNextQueued` releases
 * that role atomically when the queue is empty.
 */
async function driveRunAndDrain(
  sessionId: string,
  firstRun: ChatRun,
  firstMessage: QueuedChatMessage,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  let run = firstRun;
  let message = firstMessage;

  try {
    for (;;) {
      await driveSingleRun(sessionId, run, message, dependencies);

      const next = chatRunRegistry.takeNextQueued(sessionId);
      if (!next) {
        // Queue empty; the dispatcher role was released inside takeNextQueued.
        return;
      }

      const session = sessionsDb.getSessionById(sessionId);
      if (!session) {
        // Session was deleted while messages were queued: there is no valid
        // target left. Discard the dequeued message plus the remainder and
        // release the dispatcher so a future send for a recreated session can
        // start fresh instead of being absorbed into an orphaned queue.
        const discarded = chatRunRegistry.releaseDispatcher(sessionId) + 1;
        console.warn('[Chat] Session no longer exists; discarding queued messages', {
          sessionId,
          discarded,
        });
        return;
      }

      run = chatRunRegistry.startDispatchedRun(
        {
          appSessionId: sessionId,
          provider: session.provider as LLMProvider,
          providerSessionId: session.provider_session_id,
          connection: next.connection,
          userId: next.userId,
        },
        next,
      );
      message = next;
    }
  } catch (error) {
    // driveSingleRun never throws, so this only fires on an unexpected failure
    // between runs (e.g. a DB error resolving the next session row). Never leave
    // the session wedged: complete any in-flight run and force-release the
    // dispatcher so the next send can start a clean run.
    const errorMessage = error instanceof Error ? error.message : String(error);
    const discarded = chatRunRegistry.releaseDispatcher(sessionId);
    chatRunRegistry.completeRun(sessionId, { exitCode: 1 });
    console.error('[Chat] Dispatch loop failed; released session dispatcher', {
      sessionId,
      discarded,
      error: errorMessage,
    });
  }
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client), then
 * either starts a run immediately or, when a run is already in progress for the
 * session, appends the message to the server-side FIFO queue so it is delivered
 * in order once the current run finishes — never rejected and dropped.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return;
  }

  const provider = session.provider as LLMProvider;
  const spawnFn = dependencies.spawnFns[provider];
  if (!spawnFn) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return;
  }

  const message: QueuedChatMessage = {
    content: typeof data.content === 'string' ? data.content : '',
    options: (data.options ?? {}) as AnyRecord,
    connection: ws,
    userId,
    enqueuedAt: Date.now(),
  };

  const result = chatRunRegistry.submitMessage(
    {
      appSessionId: sessionId,
      provider,
      providerSessionId: session.provider_session_id,
      connection: ws,
      userId,
    },
    message,
  );

  if (result.action === 'draining') {
    // The server has begun its shutdown drain: new runs are refused so an
    // imminent restart cannot guillotine this turn mid-stream. Surfaced visibly
    // (never a silent drop) so the client keeps the message and can retry once
    // the server is back (issue #70). Logged server-side too, mirroring the
    // queue-full branch below, so a drain refusal is observable during a deploy.
    console.warn('[Chat] Refusing send during shutdown drain', { sessionId });
    sendProtocolError(
      ws,
      'SERVER_DRAINING',
      'The server is restarting; your message was not sent. Please retry in a moment.',
      sessionId
    );
    return;
  }

  if (result.action === 'rejected') {
    // Only reached under a pathological backlog (a stuck run or a flooding
    // client). Surfaced visibly (never a silent drop) so the client can keep
    // the message and retry, and logged for operator visibility.
    console.warn('[Chat] Queue full; rejecting send', {
      sessionId,
      pending: chatRunRegistry.getPendingCount(sessionId),
    });
    sendProtocolError(
      ws,
      'QUEUE_FULL',
      `Session "${sessionId}" has too many queued messages; wait for it to catch up.`,
      sessionId
    );
    return;
  }

  if (result.action === 'queued') {
    // A run is already in progress: the message now sits in the server-side
    // FIFO queue and the session's active dispatcher will send it in order.
    // Crucially, the send is no longer rejected — the losing device of a
    // two-device flush race keeps its message instead of dropping it.
    return;
  }

  // result.action === 'start': this task owns the session's dispatcher. Drive
  // the head run to completion, then drain anything that queued while it ran.
  await driveRunAndDrain(sessionId, result.run, message, dependencies);
}

/**
 * Parses a persisted `options_json` blob back into a chat.send options object,
 * tolerating corruption by falling back to empty options rather than throwing on
 * the resume path.
 */
function parsePersistedOptions(optionsJson: string): AnyRecord {
  try {
    const parsed = JSON.parse(optionsJson);
    return parsed && typeof parsed === 'object' ? (parsed as AnyRecord) : {};
  } catch {
    return {};
  }
}

/**
 * Handles `chat.resume`: re-dispatches the messages a previous server lifecycle
 * left interrupted for a session (issue #70). The startup reconcile flags any
 * in-flight/queued rows as `interrupted`; this replays them, in their original
 * arrival order, through the normal submit path — the first starts a run
 * (resuming the provider transcript by provider-native id) and the rest queue
 * behind it. If a run is already live for the session (the user resumed after
 * already sending something new), every replayed message simply queues.
 *
 * Each interrupted row's marker is dropped only once its message has been
 * re-recorded as a live journal row, so a resume that is itself cut short (queue
 * full, or a second restart mid-resume) still leaves the not-yet-replayed
 * messages resumable — never silently lost.
 */
async function handleChatResume(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.resume requires a sessionId.');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId);
    return;
  }

  const provider = session.provider as LLMProvider;
  const spawnFn = dependencies.spawnFns[provider];
  if (!spawnFn) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return;
  }

  const pending = activeRunsDb.getInterrupted(sessionId);
  if (pending.length === 0) {
    // Nothing to resume (already resumed elsewhere, or the run completed). Ack so
    // the client can clear its interrupted affordance without guessing.
    sendJson(ws, { kind: 'chat_resumed', sessionId, resumed: 0, timestamp: new Date().toISOString() });
    return;
  }

  let startedRun: ChatRun | null = null;
  let startedMessage: QueuedChatMessage | null = null;
  let resumed = 0;

  for (const row of pending) {
    const message: QueuedChatMessage = {
      content: row.content,
      options: parsePersistedOptions(row.options_json),
      connection: ws,
      userId,
      enqueuedAt: Date.now(),
    };

    const result = chatRunRegistry.submitMessage(
      {
        appSessionId: sessionId,
        provider,
        providerSessionId: session.provider_session_id,
        connection: ws,
        userId,
      },
      message,
    );

    if (result.action === 'draining') {
      // Server is shutting down again mid-resume: stop, leaving the remaining
      // interrupted markers in place so they stay resumable after the restart.
      console.warn('[Chat] Refusing resume during shutdown drain', { sessionId });
      sendProtocolError(
        ws,
        'SERVER_DRAINING',
        'The server is restarting; resume was not started. Please retry in a moment.',
        sessionId
      );
      return;
    }

    if (result.action === 'rejected') {
      // Queue at capacity: stop here, leaving this and the remaining interrupted
      // markers untouched so nothing is lost — the user can resume the rest once
      // the backlog drains.
      sendProtocolError(
        ws,
        'QUEUE_FULL',
        `Session "${sessionId}" has too many queued messages; wait for it to catch up.`,
        sessionId
      );
      break;
    }

    // start or queued: the message now owns a fresh live journal row (inserted
    // by submitMessage), so retire the old interrupted marker. Order matters —
    // the new row is written BEFORE this delete, so a hard kill in between leaves
    // a harmless duplicate (re-surfaced on the next reconcile) rather than losing
    // the message. Best-effort: a DB failure here must NOT abort the resume,
    // which has already registered/queued the live run — throwing would skip the
    // trailing driveRunAndDrain and wedge the session (running forever, its queue
    // never drained). The new row carries the work forward regardless.
    try {
      activeRunsDb.remove(row.id);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.error('[Chat] Failed to retire interrupted marker on resume', { sessionId, error: messageText });
    }
    resumed += 1;
    if (result.action === 'start') {
      startedRun = result.run;
      startedMessage = message;
    }
  }

  sendJson(ws, { kind: 'chat_resumed', sessionId, resumed, timestamp: new Date().toISOString() });

  // Only a resume that started the head run owns the dispatcher and must drive
  // the drain; if a run was already live, its existing dispatcher picks up
  // everything that just queued.
  if (startedRun && startedMessage) {
    await driveRunAndDrain(sessionId, startedRun, startedMessage, dependencies);
  }
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const abortFn = dependencies.abortFns[run.provider];
  let success = false;
  if (abortFn && run.providerSessionId) {
    success = Boolean(await abortFn(run.providerSessionId));
  }

  // Scoped to THIS run, not the session: the Claude abort is async, and while it
  // is awaited the aborted run can finish and the dispatcher can start the
  // session's next queued message. A session-keyed complete would then terminate
  // that newer run — a message the user never aborted — leaving the client with
  // a terminal `complete` for a turn that is still streaming.
  chatRunRegistry.completeRunIfCurrent(run, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the provider-native id inside the
    // Claude runtime; remap their sessionId so the client only sees app ids.
    const pendingPermissions = (run?.providerSessionId
      ? dependencies.getPendingApprovalsForSession(run.providerSessionId)
      : []
    ).map((approval) =>
      approval && typeof approval === 'object'
        ? { ...(approval as AnyRecord), sessionId }
        : approval,
    );

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      // Surfaces a session whose in-flight/queued work was stranded by a server
      // restart so the client can offer a one-click resume instead of showing it
      // as silently idle/Done (issue #70). A live run is never interrupted.
      interrupted: !isProcessing && activeRunsDb.hasInterrupted(sessionId),
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.resume`             { sessionId }  (re-dispatch restart-interrupted work)
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * A `chat.send` that arrives while the session already has a run in progress is
 * appended to a server-side FIFO queue and dispatched in order once the current
 * run finishes — it is NOT rejected. A `QUEUE_FULL` protocol_error is only
 * emitted when that queue exceeds its per-session cap (pathological backlog).
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.resume':
          await handleChatResume(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
