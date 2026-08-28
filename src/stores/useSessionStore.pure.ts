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
  const serverIds = new Set(serverMessages.map((serverMessage) => serverMessage.id));
  // A realtime row the transcript already carries — same id, or an optimistic
  // `local_*` prompt whose text has since been persisted — is one turn seen
  // twice. Counting both copies pushed the ordinal past the end of the server
  // transcript, `findServerTurnRangeByOrdinal` then returned null, and the
  // same-turn echo check gave up: the finalized reply was rendered a second
  // time next to its persisted copy. The `local_*` guard mirrors `computeMerged`
  // and `pruneRealtimeSupersededByServer`: only optimistic rows are collapsed
  // against their server echo, so a non-optimistic user row is never dropped.
  const alreadyOnServer = (realtimeMessage: NormalizedMessage): boolean =>
    serverIds.has(realtimeMessage.id)
    || (realtimeMessage.id.startsWith('local_') && hasServerEchoForLocalUser(realtimeMessage, serverMessages));
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

  const serverIds = new Set(serverMessages.map((message) => message.id));

  return realtimeMessages.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }

    if (message.id.startsWith('local_') && hasServerEchoForLocalUser(message, serverMessages)) {
      return false;
    }

    if (message.kind === 'stream_delta' || message.id === `__streaming_${message.sessionId}`) {
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

  const serverIds = new Set(server.map((message) => message.id));
  const extra = realtime.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }
    // Optimistic user rows use `local_*` ids; once the same text exists on the
    // server-backed copy from the same send window, drop the realtime echo to
    // avoid duplicate bubbles without hiding repeated prompts from history.
    if (message.id.startsWith('local_')) {
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
 * True when a freshly-fetched transcript says exactly what the loaded one does.
 *
 * Opening a conversation always refetches it, which is right — the file may have
 * moved on. But re-opening one nothing has written to is the common case, and
 * the fetch returns rows that are byte-for-byte what is already on screen in a
 * brand-new array. Assigning it re-renders the whole transcript for no visible
 * change: on a page of code-heavy messages that is markdown parsing and syntax
 * highlighting redone from scratch, and it measured as ~320 ms of blocked main
 * thread every time a user clicked back to a conversation they had just left.
 *
 * The comparison covers every field the transcript's rendering reads and that
 * can legitimately change between two reads of an append-only file. `toolResult`
 * is the one that is easy to miss and would matter: a `tool_use` row is written
 * before its result exists, so a later read of the *same* row genuinely differs
 * only there.
 */
export function isSameServerTranscript(
  loaded: NormalizedMessage[],
  fetched: NormalizedMessage[],
): boolean {
  if (loaded === fetched) {
    return true;
  }
  if (loaded.length !== fetched.length) {
    return false;
  }

  for (let index = 0; index < loaded.length; index++) {
    const left = loaded[index];
    const right = fetched[index];
    if (left === right) {
      continue;
    }
    if (
      left.id !== right.id
      || left.kind !== right.kind
      || left.role !== right.role
      || left.timestamp !== right.timestamp
      || left.content !== right.content
      || left.isError !== right.isError
      || left.toolId !== right.toolId
      || left.toolResult?.content !== right.toolResult?.content
      || left.toolResult?.isError !== right.toolResult?.isError
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Splices a freshly-read *tail* of the server transcript onto the rows already
 * loaded.
 *
 * A full refresh can simply replace `serverMessages`, because it holds the
 * whole transcript. A windowed refresh cannot: replacing a 900-message slot
 * with the newest 40 would erase everything the user had scrolled back to.
 *
 * Transcripts are append-only, so the two arrays overlap at their join and the
 * newest page is authoritative for everything from its first row onward. That
 * makes the merge a splice: keep the loaded rows that predate the page, then
 * take the page.
 *
 * When the page's first row is not among the loaded rows the two windows are
 * disjoint — the page is entirely newer — and it is appended. A gap is possible
 * in principle (more rows appended than the window covers), which is why
 * callers size the window from what they need reconciled rather than by taste.
 */
export function mergeRefreshedTail(
  loaded: NormalizedMessage[],
  page: NormalizedMessage[],
): NormalizedMessage[] {
  if (page.length === 0) {
    return loaded;
  }
  if (loaded.length === 0) {
    return page;
  }

  const joinIndex = findRefreshTailJoin(loaded, page);
  return joinIndex >= 0
    ? [...loaded.slice(0, joinIndex), ...page]
    : [...loaded, ...page];
}

/**
 * Where a refreshed page joins the rows already loaded, or `-1` when it does
 * not reach back far enough to touch them.
 *
 * `-1` is the case worth acting on. It means the window the caller asked for
 * was smaller than the number of rows appended since, so the two arrays do not
 * overlap and there is no way to tell whether messages sit in the gap between
 * them. Appending anyway produces a transcript with a hole that nothing later
 * repairs — `fetchMore` paginates *older* than what is loaded, so it walks past
 * the gap rather than into it. Callers use this to fall back to an unwindowed
 * read instead of splicing something they cannot verify.
 */
export function findRefreshTailJoin(
  loaded: NormalizedMessage[],
  page: NormalizedMessage[],
): number {
  if (page.length === 0 || loaded.length === 0) {
    return -1;
  }
  return loaded.findIndex((message) => message.id === page[0].id);
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
export function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}
