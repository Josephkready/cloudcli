import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { createCompleteMessage, readObjectRecord } from '@/shared/utils.js';

type ChatSessionWriterOptions = {
  /**
   * The connection that started the run, seeded as the first subscriber. Optional
   * because the writer's subscriber set can legitimately be empty (every viewer
   * left mid-run); further subscribers arrive via `addConnection`.
   */
  connection?: RealtimeClientConnection;
  userId: string | number | null;
  provider: LLMProvider;
  /** Provider-native id when resuming an existing session, otherwise null. */
  providerSessionId: string | null;
  /**
   * Invoked the moment the provider runtime reveals its native session id
   * (either via `setSessionId` or a `session_created` event). The registry
   * persists the app-id-to-provider-id mapping from this callback.
   */
  onProviderSessionId: (providerSessionId: string) => void;
  /**
   * Invoked when the run enters or leaves a blocked/awaiting-input state (a
   * permission prompt or the indefinite plan-mode / `AskUserQuestion` approval).
   * The registry records this so the sidebar can rank a blocked-but-running
   * session as "needs attention" regardless of which client started the run.
   */
  onBlockedChange?: (blocked: boolean) => void;
  /**
   * Whether this run is still live (registry status `running`). Providers use it
   * to bail out of internal retries once the run has been completed/aborted out
   * from under them, so they don't stream into a session the client believes is
   * finished.
   */
  isRunActive?: () => boolean;
  /**
   * Remaps/sequences/buffers one outbound live event. Implemented by the chat
   * run registry; the writer never forwards a provider event untouched.
   * Returns `null` when the event must be dropped (duplicate terminal
   * `complete` after an abort already completed the run).
   */
  decorateOutboundEvent: (message: NormalizedMessage) => NormalizedMessage | null;
};

/**
 * Gateway writer handed to provider runtimes instead of a raw websocket writer.
 *
 * It exposes the runtime-facing surface `WebSocketWriter` provides (`send`,
 * `setSessionId`, `getSessionId`, `userId`, `isWebSocketWriter`) so the provider
 * runtimes (`claude-sdk.js`, ...) need zero changes — but everything that flows
 * through it is translated from the provider's world into the app's protocol.
 * Connection management differs: instead of a single replaceable `ws`, it holds
 * a fan-out set managed via `addConnection`/`removeConnection` (issue #204), so
 * one run can stream to several devices at once:
 *
 * - `session_created` events are swallowed and turned into a provider-id
 *   mapping; the frontend never learns provider-native ids.
 * - every other event gets `sessionId` remapped to the app session id and a
 *   per-run `seq` assigned before being forwarded.
 * - `setSessionId(...)` calls (used by runtimes to label captured ids) are
 *   intercepted and recorded as the provider-id mapping as well.
 */
export class ChatSessionWriter {
  userId: string | number | null;
  /**
   * Some runtimes feature-detect their writer with this flag; keep it so the
   * gateway writer is a drop-in replacement for `WebSocketWriter`.
   */
  isWebSocketWriter = true;

  private readonly options: ChatSessionWriterOptions;
  /**
   * The set of live subscriber sockets receiving this run's stream. A single
   * run can be watched from several devices/tabs at once (issue #204), so every
   * outbound event fans out to ALL open connections here rather than a single
   * "current" socket a later subscriber would steal. Non-open sockets are
   * pruned on send; the chat handler also removes a socket from every run's set
   * when it closes.
   */
  private readonly connections = new Set<RealtimeClientConnection>();
  /**
   * The provider-native session id as the runtime knows it. Kept locally
   * (besides the registry) because runtimes read it back via `getSessionId()`
   * to label their own outgoing events — those labels are remapped on send
   * anyway, but the runtime-visible value must stay provider-native.
   */
  private providerSessionId: string | null;

  constructor(options: ChatSessionWriterOptions) {
    this.options = options;
    this.userId = options.userId;
    this.providerSessionId = options.providerSessionId;
    if (options.connection) {
      this.connections.add(options.connection);
    }
  }

  send(data: unknown): void {
    const record = readObjectRecord(data);
    if (!record || typeof record.kind !== 'string') {
      // Provider runtimes only emit kind-based normalized messages. Anything
      // else indicates a programming error; drop it rather than leaking an
      // un-remapped payload to the client.
      console.error('[ChatSessionWriter] Dropping non-normalized outbound payload', data);
      return;
    }

    const message = record as NormalizedMessage;

    if (message.kind === 'session_created') {
      const announcedId =
        typeof message.newSessionId === 'string' && message.newSessionId
          ? message.newSessionId
          : message.sessionId;
      if (announcedId) {
        this.captureProviderSessionId(announcedId);
      }
      // Swallowed on purpose: the frontend already has the stable app session
      // id, so there is no client-side handoff to perform anymore.
      return;
    }

    const outbound = this.options.decorateOutboundEvent(message);
    if (outbound) {
      this.forward(outbound);
    }
  }

  /**
   * Emits the synthetic terminal `complete` for runs that ended without one
   * (runtime crash before completing, or user abort).
   */
  sendComplete(opts: { exitCode: number; aborted?: boolean }): void {
    const message = createCompleteMessage({
      provider: this.options.provider,
      sessionId: this.providerSessionId,
      exitCode: opts.exitCode,
      aborted: opts.aborted,
    });
    const outbound = this.options.decorateOutboundEvent(message);
    if (outbound) {
      this.forward(outbound);
    }
  }

  /**
   * Adds a subscriber connection to the fan-out set. Called on `chat.subscribe`
   * so a second device (or a reconnecting one) JOINS the live stream instead of
   * replacing the socket that started the run — the previous fix redirected the
   * stream, leaving the first device dark and stuck "processing" (issue #204).
   * Idempotent: a socket that re-subscribes is de-duplicated by the Set.
   */
  addConnection(newConnection: RealtimeClientConnection): void {
    this.connections.add(newConnection);
  }

  /**
   * Removes one subscriber connection (its socket closed). The run itself is
   * untouched — remaining and future subscribers keep receiving the stream, and
   * the buffered events stay replayable. Returns whether the connection had been
   * attached, so the caller can count how many runs a closing socket left.
   */
  removeConnection(connection: RealtimeClientConnection): boolean {
    return this.connections.delete(connection);
  }

  /** Number of live subscriber connections (test/introspection helper). */
  get connectionCount(): number {
    return this.connections.size;
  }

  setSessionId(sessionId: string): void {
    this.captureProviderSessionId(sessionId);
  }

  getSessionId(): string | null {
    return this.providerSessionId;
  }

  /**
   * Signals that the run is (un)blocked waiting on the user around an
   * interactive approval await. Forwarded to the registry via `onBlockedChange`.
   */
  setBlocked(blocked: boolean): void {
    this.options.onBlockedChange?.(blocked);
  }

  /**
   * Whether this run is still live. Defaults to true when the host didn't wire a
   * status source (e.g. non-registry writers), so a provider only bails when it
   * is explicitly told the run is no longer active.
   */
  isRunActive(): boolean {
    return this.options.isRunActive?.() ?? true;
  }

  private captureProviderSessionId(providerSessionId: string): void {
    if (!providerSessionId || this.providerSessionId === providerSessionId) {
      return;
    }

    this.providerSessionId = providerSessionId;
    this.options.onProviderSessionId(providerSessionId);
  }

  private forward(message: NormalizedMessage): void {
    // Fan out to every subscribed socket. Serialize once and gate each socket on
    // its own readyState so one dead connection never blocks the others, and
    // prune closed sockets so the set cannot leak references to gone tabs. Each
    // send is isolated in its own try/catch: `ws.send` can still throw (a socket
    // that raced from OPEN to closing, an internal buffer error), and one such
    // throw must not skip delivery to — or pruning of — the remaining sockets.
    const serialized = JSON.stringify(message);
    for (const connection of this.connections) {
      if (connection.readyState !== WS_OPEN_STATE) {
        this.connections.delete(connection);
        continue;
      }
      try {
        connection.send(serialized);
      } catch (error) {
        this.connections.delete(connection);
        const messageText = error instanceof Error ? error.message : String(error);
        console.error('[ChatSessionWriter] Failed to send to a subscriber; pruning it', messageText);
      }
    }
  }
}
