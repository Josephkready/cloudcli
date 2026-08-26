/**
 * Pure message-merge logic for the session store.
 *
 * Everything here is a plain function over plain data: no React, no fetch, no
 * module state. `useSessionStore` is the thin stateful wrapper that calls into
 * it. Keeping the merge/dedup/ordering rules in their own module is what makes
 * them unit-testable — bugs in here duplicate or drop chat bubbles, which is
 * the most user-visible failure mode the front-end has.
 */

import type { LLMProvider } from '../types/app';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification';

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Per-run monotonic sequence number assigned by the backend to live
   * websocket events. Used to compute `lastSeq` for `chat.subscribe` replay;
   * REST history messages do not carry it.
   */
  seq?: number;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Mirrors optional transcript metadata from the server.
   *
   * These fields are currently used by Claude history normalization so local
   * slash commands, local stdout, and compact summaries do not disappear when
   * the session store hydrates from REST history.
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  images?: Array<{ path?: string; data?: string; name?: string }>;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  isFinal?: boolean;
  // Provider-native transcript ordering hints
  sequence?: number;
  rowid?: number;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  /**
   * @internal Monotonic ticket per server fetch (fetch/refresh/fetchMore) and
   * the ticket of the last response applied. Concurrent fetches for the same
   * session can resolve out of order — e.g. the `complete` refresh racing the
   * watcher-triggered refresh right as a queued message is flushed — and a
   * stale response applied last would wind `serverMessages` back to a
   * transcript that no longer matches what the user already saw.
   */
  _fetchSeq: number;
  _appliedFetchSeq: number;
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
}

const EMPTY: NormalizedMessage[] = [];

export function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    _fetchSeq: 0,
    _appliedFetchSeq: 0,
  };
}

// ─── Merge / dedup ───────────────────────────────────────────────────────────

/**
 * Compute merged messages: server + realtime, deduped by id and adjacent
 * assistant echo (same trimmed text), so finalized stream rows do not stack
 * on top of the persisted copy before realtime is cleared.
 */
export const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
export const LOCAL_USER_DEDUPE_CLOCK_SKEW_MS = 10_000;

export function userTextFingerprint(m: NormalizedMessage): string | null {
  if (m.kind !== 'text' || m.role !== 'user') return null;
  const t = (m.content || '').trim();
  return t.length > 0 ? t : null;
}

export function readMessageTime(m: NormalizedMessage): number | null {
  const time = Date.parse(m.timestamp);
  return Number.isFinite(time) ? time : null;
}

/**
 * Does this row carry an id we can dedupe and render by?
 *
 * Every genuine transcript row is minted by `createNormalizedMessage` on the
 * server or `chatMessageToNormalized` on the client, and both guarantee an id.
 * Frames hand-rolled by the websocket gateway (`chat_resumed`,
 * `projects_snapshot_stale`, …) do not, and one of those reaching the merge
 * path threw on an unguarded `id.startsWith('local_')` — which froze the
 * session's merged view for the rest of the app's life (#450/#389).
 */
export function hasUsableMessageId(m: NormalizedMessage | null | undefined): boolean {
  return typeof m?.id === 'string' && m.id.length > 0;
}

/**
 * Read an id defensively. Merge is a pure read over data that came off a
 * socket: a single malformed row must degrade that row, never the transcript.
 */
function readMessageId(m: NormalizedMessage): string {
  return typeof m?.id === 'string' ? m.id : '';
}

/**
 * Ids present in `messages`, skipping rows that have none.
 *
 * Built with a skip rather than a raw `.map()` because `new Set([undefined])`
 * makes `serverIds.has(undefined)` true, which would silently drop every
 * id-less realtime row as "already on the server".
 */
function collectMessageIds(messages: NormalizedMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const id = readMessageId(message);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Is this local user message already present in the server transcript?
 *
 * The accepted window runs from the message's *earliest* send attempt to
 * `LOCAL_USER_DEDUPE_WINDOW_MS` past its latest one.
 *
 * `earliestAttemptAt` exists because a pending send can be retried, and a retry
 * restamps the entry to the moment it went out again (see `retimePendingSend`).
 * Anchoring the lower bound to that new timestamp orphaned the row the *first*
 * attempt had already written: it was suddenly "too old", the entry could never
 * be confirmed again, and it was resent on every subsequent transcript refresh —
 * which is how one prompt reached Claude five times (#347/#350). Reaching back
 * to the first attempt keeps the original echo matchable while the upper bound,
 * still measured from the latest attempt, keeps a late resend's own echo
 * matchable too.
 *
 * Callers with a single attempt (optimistic bubble dedupe) omit it and get the
 * previous behaviour exactly: the bound falls back to the message's timestamp.
 */
export function hasServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  options: { earliestAttemptAt?: number } = {},
): boolean {
  const localText = userTextFingerprint(localMessage);
  const localTime = readMessageTime(localMessage);
  if (!localText || localTime === null) {
    return false;
  }

  const earliestAttemptAt =
    typeof options.earliestAttemptAt === 'number' && Number.isFinite(options.earliestAttemptAt)
      // A malformed stored value must never widen the window past the real send.
      ? Math.min(options.earliestAttemptAt, localTime)
      : localTime;

  return serverMessages.some((serverMessage) => {
    if (userTextFingerprint(serverMessage) !== localText) {
      return false;
    }

    const serverTime = readMessageTime(serverMessage);
    return (
      serverTime !== null
      && serverTime >= earliestAttemptAt - LOCAL_USER_DEDUPE_CLOCK_SKEW_MS
      && serverTime - localTime <= LOCAL_USER_DEDUPE_WINDOW_MS
    );
  });
}

export function compareMessagesChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = readMessageTime(a) ?? 0;
  const timeB = readMessageTime(b) ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }
  return 0;
}

/**
 * Count how many user turns precede `message` in a chronologically merged view
 * of server + realtime rows. Used to match a realtime row to the correct turn
 * on disk when several turns share identical assistant text.
 */
export function getUserTurnOrdinalBefore(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): number {
  const messageTime = readMessageTime(message);
  const serverIds = collectMessageIds(serverMessages);
  // A realtime row the transcript already carries — same id, or an optimistic
  // `local_*` prompt whose text has since been persisted — is one turn seen
  // twice. Counting both copies pushed the ordinal past the end of the server
  // transcript, `findServerTurnRangeByOrdinal` then returned null, and the
  // same-turn echo check gave up: the finalized reply was rendered a second
  // time next to its persisted copy. The `local_*` guard mirrors `computeMerged`
  // and `pruneRealtimeSupersededByServer`: only optimistic rows are collapsed
  // against their server echo, so a non-optimistic user row is never dropped.
  const alreadyOnServer = (realtimeMessage: NormalizedMessage): boolean =>
    serverIds.has(readMessageId(realtimeMessage))
    || (readMessageId(realtimeMessage).startsWith('local_')
      && hasServerEchoForLocalUser(realtimeMessage, serverMessages));
  const candidates = [
    ...serverMessages,
    ...realtimeMessages.filter((realtimeMessage) => !alreadyOnServer(realtimeMessage)),
  ].sort(compareMessagesChronologically);

  let userCount = 0;

  for (const candidate of candidates) {
    if (candidate.id === message.id) {
      break;
    }

    const candidateTime = readMessageTime(candidate);
    if (
      messageTime !== null
      && candidateTime !== null
      && candidateTime > messageTime
    ) {
      break;
    }

    if (candidate.kind === 'text' && candidate.role === 'user') {
      userCount++;
    }
  }

  return Math.max(0, userCount - 1);
}

export function findServerTurnRangeByOrdinal(
  serverMessages: NormalizedMessage[],
  turnOrdinal: number,
): { start: number; end: number } | null {
  let userCount = -1;
  let start = -1;

  for (let index = 0; index < serverMessages.length; index++) {
    const message = serverMessages[index];
    if (message.kind === 'text' && message.role === 'user') {
      userCount++;
      if (userCount === turnOrdinal) {
        start = index;
        break;
      }
    }
  }

  if (start < 0) {
    return null;
  }

  let end = serverMessages.length;
  for (let index = start + 1; index < serverMessages.length; index++) {
    if (serverMessages[index].kind === 'text' && serverMessages[index].role === 'user') {
      end = index;
      break;
    }
  }

  return { start, end };
}

export function isAssistantTextEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): boolean {
  const assistantText = (message.content || '').trim();
  if (!assistantText) {
    return false;
  }

  const turnOrdinal = getUserTurnOrdinalBefore(message, serverMessages, realtimeMessages);
  const turnRange = findServerTurnRangeByOrdinal(serverMessages, turnOrdinal);
  if (!turnRange) {
    return false;
  }

  return serverMessages
    .slice(turnRange.start + 1, turnRange.end)
    .some((serverMessage) =>
      serverMessage.kind === 'text'
      && serverMessage.role === 'assistant'
      && (serverMessage.content || '').trim() === assistantText,
    );
}

/**
 * After `finalizeStreaming`, the client holds a synthetic assistant `text` row
 * while the sessions API soon returns the same reply with a different id.
 * Those sit back-to-back in merged order and look like duplicate bubbles until
 * `refreshFromServer` clears realtime. Collapse same-text assistant rows and
 * stream_placeholder → text when content matches.
 */
export function dedupeAdjacentAssistantEchoes(merged: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of merged) {
    const prev = out[out.length - 1];
    if (prev) {
      if (prev.kind === 'stream_delta' && m.kind === 'text' && m.role === 'assistant') {
        const ps = (prev.content || '').trim();
        const ms = (m.content || '').trim();
        if (ps.length > 0 && ps === ms) {
          out[out.length - 1] = m;
          continue;
        }
      }
      if (
        prev.kind === 'text'
        && m.kind === 'text'
        && prev.role === 'assistant'
        && m.role === 'assistant'
      ) {
        const ms = (m.content || '').trim();
        if (ms.length > 0 && ms === (prev.content || '').trim()) {
          continue;
        }
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * After a server refresh, drop only the realtime rows the persisted transcript
 * already owns. Anything not yet on disk (common right after `complete`, while
 * JSONL indexing lags) stays in `realtimeMessages` so the chat pane never
 * flashes the empty "Continue your conversation" state.
 */
export function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  if (realtimeMessages.length === 0) {
    return realtimeMessages;
  }

  const serverIds = collectMessageIds(serverMessages);

  return realtimeMessages.filter((message) => {
    const messageId = readMessageId(message);
    if (messageId && serverIds.has(messageId)) {
      return false;
    }

    if (messageId.startsWith('local_') && hasServerEchoForLocalUser(message, serverMessages)) {
      return false;
    }

    if (message.kind === 'stream_delta' || messageId === `__streaming_${message.sessionId}`) {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'assistant') {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'user') {
      return !hasServerEchoForLocalUser(message, serverMessages);
    }

    if (message.kind === 'tool_use' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_use' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    return true;
  });
}

export function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }
  if (server.length === 0) {
    return dedupeAdjacentAssistantEchoes(realtime);
  }

  const serverIds = collectMessageIds(server);
  const extra = realtime.filter((message) => {
    const messageId = readMessageId(message);
    if (messageId && serverIds.has(messageId)) {
      return false;
    }
    // Optimistic user rows use `local_*` ids; once the same text exists on the
    // server-backed copy from the same send window, drop the realtime echo to
    // avoid duplicate bubbles without hiding repeated prompts from history.
    if (messageId.startsWith('local_')) {
      if (hasServerEchoForLocalUser(message, server)) {
        return false;
      }
    }
    return true;
  });

  if (extra.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }

  // Interleave by timestamp so live rows stay with their turn instead of
  // piling up at the bottom after every refresh.
  return dedupeAdjacentAssistantEchoes(
    [...server, ...extra].sort(compareMessagesChronologically),
  );
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
export function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  const server = slot.serverMessages;
  const realtime = slot.realtimeMessages;
  slot.merged = computeMerged(server, realtime);
  // Claim these inputs as merged only once the merge has actually succeeded.
  // Assigning first meant a throw inside `computeMerged` left the refs asserting
  // work that never happened: every later recompute short-circuited on the
  // reference check and the slot served a frozen `merged` for the rest of the
  // session, which is the "chat stuck until I reopen the app" half of #389.
  slot._lastServerRef = server;
  slot._lastRealtimeRef = realtime;
  return true;
}
