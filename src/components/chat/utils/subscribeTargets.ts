/**
 * Pure builder for the `chat.subscribe` target list.
 *
 * Historically both subscribe senders (session open and websocket reconnect)
 * passed only the *viewed* session, so after a reconnect any session running in
 * the background kept its server-side writer pointed at the dead socket — its
 * live stream and terminal `complete` never reached the new socket until the
 * user happened to switch to it (issue #204).
 *
 * This builds a batch that always includes the selected session (first, so it
 * keeps its place / richer intent) plus every session the client believes is
 * running, de-duplicated. The protocol already accepts an array, so the client
 * re-attaches ALL running sessions in a single frame. Each target carries the
 * client's highest-seen `seq` as `lastSeq`, so the server replays only what this
 * client actually missed — for a session it has already been streaming that is a
 * no-op, and for a background one it catches up exactly the buffered gap.
 */
export interface SubscribeTarget {
  sessionId: string;
  lastSeq: number;
}

export function buildSubscribeTargets(params: {
  /** The session currently being viewed, if any. Always subscribed first. */
  selectedSessionId: string | null | undefined;
  /** Every session id the client believes is running (from the running-sessions poll). */
  runningSessionIds: Iterable<string>;
  /** Highest live `seq` the client has seen for a session; sent as `lastSeq`. */
  lastSeqFor: (sessionId: string) => number;
}): SubscribeTarget[] {
  const { selectedSessionId, runningSessionIds, lastSeqFor } = params;

  const targets: SubscribeTarget[] = [];
  const seen = new Set<string>();

  const push = (sessionId: string | null | undefined): void => {
    const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    targets.push({ sessionId: trimmed, lastSeq: lastSeqFor(trimmed) });
  };

  // The viewed session leads the batch; the rest of the running set follows.
  push(selectedSessionId);
  for (const sessionId of runningSessionIds) {
    push(sessionId);
  }

  return targets;
}

/**
 * Builds the subscribe batch and, if non-empty, dispatches it: stamps each
 * target's send time (for the stale-idle-ack guard) and sends one
 * `chat.subscribe` frame. Extracted from the two React call sites
 * (`ChatInterface.handleWebSocketReconnect`, `useChatSessionState`) so the
 * wiring — sourcing the running set, batching, and sending — is unit-testable
 * without a DOM. Returns the targets it sent (empty array = nothing sent).
 */
export function sendSubscribeBatch(params: {
  selectedSessionId: string | null | undefined;
  runningSessionIds: Iterable<string>;
  lastSeqFor: (sessionId: string) => number;
  /** Clock stamp recorded for every target's send time. */
  now: number;
  /** Records when a session's subscribe was sent (guards stale idle acks). */
  markSubscribeSent: (sessionId: string, at: number) => void;
  /** The websocket send function. */
  send: (message: { type: 'chat.subscribe'; sessions: SubscribeTarget[] }) => void;
}): SubscribeTarget[] {
  const { now, markSubscribeSent, send, ...targetParams } = params;
  const targets = buildSubscribeTargets(targetParams);
  if (targets.length === 0) {
    return targets;
  }

  for (const target of targets) {
    markSubscribeSent(target.sessionId, now);
  }
  send({ type: 'chat.subscribe', sessions: targets });
  return targets;
}
