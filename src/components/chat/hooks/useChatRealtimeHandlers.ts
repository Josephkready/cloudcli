import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import { showCompletionTitleIndicator } from '../../../utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '../../../utils/notificationSound';
import type { MarkSessionIdle, MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import type { PendingPermissionRequest } from '../types/types';
import { removePendingSend } from '../utils/pendingSends';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage, MessageKind } from '../../../stores/useSessionStore';

/**
 * The only `kind`s that may be written into a session transcript.
 *
 * This is an ALLOW-list on purpose. It replaced an exclude-list of four control
 * kinds, under which every frame the client did not recognise was cast to a
 * `NormalizedMessage` and appended to the store — gateway frames included.
 * `chat_resumed` (one click on the interrupted-run banner) carries no `id`, and
 * an id-less row made the merge throw, froze the slot's `merged` view for good,
 * and took the composer's post-send bookkeeping down with it (#450/#389).
 *
 * Membership is exactly `MessageKind` — the provider-message union mirrored
 * from `server/shared/types.ts` — minus the control kinds this hook consumes as
 * events rather than rows (`complete`, `status`, `permission_request`,
 * `permission_cancelled`). So it persists precisely what the exclude-list
 * persisted for every kind either side knows about; the only behaviour change
 * is that unrecognised frames are now dropped instead of stored.
 *
 * Every kind here is minted by `createNormalizedMessage` (server) or
 * `chatMessageToNormalized` (client), both of which guarantee an `id`. Gateway
 * kinds are absent by construction: none of them is a `MessageKind`.
 *
 * Adding a provider kind? Add it here too, or it will never reach a transcript.
 * `KNOWN_CONTROL_KINDS` below exists so that omission is loud rather than
 * silent.
 */
const PERSISTED_KIND_LIST = [
  'text',
  'tool_use',
  'tool_result',
  'thinking',
  // Both stream kinds are intercepted further down and reach the store through
  // `updateStreaming`/`finalizeStreaming` instead of a raw append, so neither
  // actually reaches this check today. Listed anyway so the allow-list is a
  // faithful "these are transcript content" statement rather than a description
  // of the current control flow — if the interception ever moves, the rows are
  // already allowed rather than silently dropped.
  'stream_delta',
  'stream_end',
  'error',
  'session_created',
  // Client-only kinds. No server emits these, and they do not pass through this
  // switch either — `chatMessageToNormalized` (useChatSessionState) hands them
  // straight to `appendRealtime`. Listed for completeness, so this stays a
  // statement about what counts as transcript content rather than a description
  // of one code path.
  'interactive_prompt',
  'task_notification',
] as const satisfies readonly MessageKind[];

/**
 * Provider kinds this hook consumes as events rather than storing as rows.
 * Split out from `KNOWN_CONTROL_KINDS` so the exhaustiveness check below can
 * see that every `MessageKind` is accounted for one way or the other.
 */
const PROVIDER_CONTROL_KIND_LIST = [
  'complete',
  'status',
  'permission_request',
  'permission_cancelled',
] as const satisfies readonly MessageKind[];

/**
 * Compile-time exhaustiveness guard.
 *
 * Every `MessageKind` must be classified as either transcript content or a
 * provider control frame. Add a kind to the union and forget this file, and the
 * build breaks right here — instead of the kind silently never reaching a
 * transcript in production, which is the exact failure mode an allow-list
 * risks and the runtime `console.warn` below only reports after the fact.
 */
type UnclassifiedMessageKind = Exclude<
  MessageKind,
  (typeof PERSISTED_KIND_LIST)[number] | (typeof PROVIDER_CONTROL_KIND_LIST)[number]
>;
type AssertTrue<T extends true> = T;
export type AssertEveryMessageKindIsClassified = AssertTrue<
  [UnclassifiedMessageKind] extends [never] ? true : false
>;

const PERSISTED_MESSAGE_KINDS: ReadonlySet<string> = new Set<string>(PERSISTED_KIND_LIST);

/**
 * Frames that are legitimately not transcript rows.
 *
 * Purely so an unrecognised kind can be told apart from a deliberately excluded
 * one and warned about. Without this, a new provider kind would be dropped in
 * silence — the failure mode an allow-list has to guard against.
 */
const KNOWN_CONTROL_KINDS: ReadonlySet<string> = new Set<string>([
  // Provider lifecycle, handled as events by the switch below.
  ...PROVIDER_CONTROL_KIND_LIST,
  // Gateway frames, consumed above or by other hooks (`useInterruptedResume`
  // taps `chat_resumed` off its own subscription; `pong` is swallowed by
  // `WebSocketContext` before dispatch).
  'chat_subscribed',
  'chat_send_accepted',
  'chat_resumed',
  'pong',
  'session_upserted',
  'loading_progress',
  'projects_snapshot_stale',
  'protocol_error',
  'websocket_reconnected',
]);

/** Kinds already warned about, so one unknown frame per run does not spam. */
const warnedUnknownKinds = new Set<string>();

/**
 * Cap on distinct unknown kinds remembered. `kind` is unvalidated JSON off the
 * socket, so a buggy backend emitting a counter or id inside the kind string
 * would otherwise grow this set — and the console output — without bound for
 * the lifetime of the tab.
 */
const MAX_WARNED_UNKNOWN_KINDS = 50;

function shouldPersistKind(kind: unknown): boolean {
  if (typeof kind !== 'string') {
    return false;
  }
  if (PERSISTED_MESSAGE_KINDS.has(kind)) {
    return true;
  }
  if (
    !KNOWN_CONTROL_KINDS.has(kind)
    && !warnedUnknownKinds.has(kind)
    && warnedUnknownKinds.size < MAX_WARNED_UNKNOWN_KINDS
  ) {
    warnedUnknownKinds.add(kind);
    console.warn(
      `[Chat] Unrecognised websocket frame kind "${kind}" — not shown in the `
      + 'transcript. If this is a new provider message, add it to '
      + 'PERSISTED_KIND_LIST.',
    );
  }
  return false;
}

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

interface UseChatRealtimeHandlersArgs {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  streamingStatesRef: MutableRefObject<Map<string, StreamingState>>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  sessionStore: SessionStore;
}

export type StreamingState = {
  accumulatedText: string;
  timer: number | null;
  provider: LLMProvider;
};

export function clearStreamingStates(streamingStates: Map<string, StreamingState>): void {
  streamingStates.forEach(({ timer }) => {
    if (timer) clearTimeout(timer);
  });
  streamingStates.clear();
}

function resolveEventProvider(value: unknown, fallback: LLMProvider): LLMProvider {
  return value === 'claude' || value === 'codex' || value === 'antigravity'
    ? value
    : fallback;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar/global events (`session_upserted`, `loading_progress`,
 * `projects_snapshot_stale`) are handled by `useProjectsState`, not in this
 * hook.
 */
export function useChatRealtimeHandlers({
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  streamingStatesRef,
  lastSeqRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onWebSocketReconnect,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      // Record replay progress for every sequenced live event.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            // Symmetric with the idle branch below: a subscribe ack is only
            // authoritative for state that has not moved on since we asked. If
            // the run completed after the subscribe went out, this ack is
            // describing the finished run, and re-marking it processing would
            // strand the flag — queueing every subsequent send forever (#318).
            onSessionProcessing?.(sid, undefined, {
              ifNotIdledSince: statusCheckSentAtRef.current.get(sid),
            });
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'chat_send_accepted': {
          // The server has taken ownership of this message — it is either
          // running or sitting in the session's FIFO. Either way it will not be
          // lost, so the durable pending entry has done its job and is retired
          // by id (#389).
          //
          // This is the whole point of the ack: previously the only evidence of
          // delivery was a transcript echo, which a QUEUED message does not
          // produce until the run ahead of it finishes. Past the 30s resend
          // grace that read as "never arrived" and the message was sent a second
          // time. Confirming here makes delivery a fact rather than an inference.
          if (!sid || typeof msg.clientMessageId !== 'string') return;
          removePendingSend(sid, msg.clientMessageId);
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            onSessionIdle?.(sid);
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Ack for `chat.resume`. Owned by `useInterruptedResume`, which taps the
        // websocket fan-out on its own subscription, so there is nothing to do
        // here — but it must be named rather than left to fall through: it is a
        // gateway frame with no `id`, and appending one of those to the store
        // was what wedged the session in the first place (#450).
        case 'chat_resumed':
          return;

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
        case 'projects_snapshot_stale':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // --- Streaming: buffer for performance ---
      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!sid || !text) return;

        const eventProvider = resolveEventProvider(msg.provider, provider);
        const streamingState = streamingStatesRef.current.get(sid) ?? {
          accumulatedText: '',
          timer: null,
          provider: eventProvider,
        };
        streamingState.accumulatedText += text;
        streamingState.provider = eventProvider;
        streamingStatesRef.current.set(sid, streamingState);

        if (!streamingState.timer) {
          streamingState.timer = window.setTimeout(() => {
            const current = streamingStatesRef.current.get(sid);
            if (!current) return;

            current.timer = null;
            sessionStore.updateStreaming(sid, current.accumulatedText, current.provider);
          }, 100);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        if (sid) {
          const streamingState = streamingStatesRef.current.get(sid);
          if (streamingState?.timer) {
            clearTimeout(streamingState.timer);
          }
          if (streamingState?.accumulatedText) {
            sessionStore.updateStreaming(sid, streamingState.accumulatedText, streamingState.provider);
          }
          sessionStore.finalizeStreaming(sid);
          streamingStatesRef.current.delete(sid);
        }
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist = shouldPersistKind(msg.kind);

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Flush any remaining streaming state
          if (sid) {
            const streamingState = streamingStatesRef.current.get(sid);
            if (streamingState?.timer) {
              clearTimeout(streamingState.timer);
            }
            if (streamingState?.accumulatedText) {
              sessionStore.updateStreaming(sid, streamingState.accumulatedText, streamingState.provider);
              sessionStore.finalizeStreaming(sid);
            }
            streamingStatesRef.current.delete(sid);
          }

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void sessionStore.refreshFromServer(sid);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          if (msg.text === 'token_budget' && msg.tokenBudget) {
            setTokenBudget(msg.tokenBudget as Record<string, unknown>);
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamingStatesRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    sessionStore,
  ]);
}
