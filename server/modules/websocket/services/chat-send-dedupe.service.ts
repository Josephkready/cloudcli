/**
 * Duplicate suppression for `chat.send`, keyed on the client's own
 * `clientMessageId` (#389).
 *
 * WHY THIS EXISTS. The `chat_send_accepted` ack tells a client its message
 * landed, so the client can retire its durable pending-send entry instead of
 * waiting for a transcript echo that a *queued* message will not produce until
 * the run ahead of it finishes. But the ack is itself just an outbound frame,
 * and it can be lost exactly the way #389 loses sends: a socket whose uplink
 * still works and whose downlink is dead delivers the `chat.send`, starts or
 * queues the run, and never gets the ack back. The client then resends — and
 * without this the server would run the message a second time, which is the
 * duplicate the whole change exists to prevent.
 *
 * Deduping on an id the client already sends turns `chat.send` from
 * "acknowledged" into "idempotent per id".
 *
 * Split into its own module so the expiry and eviction rules are testable
 * against an injected clock, rather than only reachable through a websocket
 * handler and a real ten-minute wait.
 */

/**
 * How long an accepted id is remembered.
 *
 * Sized against the worst case the ack exists for, not the common one: a
 * message can sit in the per-session FIFO behind a long turn for many minutes,
 * and if its ack was lost the client's resend may not arrive until the next
 * reconnect. A short window would expire the record right when the resend
 * finally shows up, which is the duplicate this is meant to stop. Memory is
 * bounded by the per-session cap below, not by this.
 */
export const SEEN_MESSAGE_TTL_MS = 60 * 60 * 1000;

/** Hard bound per session, so a busy chat cannot grow this without limit. */
export const SEEN_MESSAGE_MAX_PER_SESSION = 200;

/** sessionId -> (clientMessageId -> accepted-at epoch ms). */
const seenClientMessageIds = new Map<string, Map<string, number>>();

/** Drops expired ids, then enforces the per-session cap oldest-first. */
function prune(seen: Map<string, number>, now: number): void {
  for (const [id, at] of seen) {
    if (now - at > SEEN_MESSAGE_TTL_MS) {
      seen.delete(id);
    }
  }
  // Map iterates in insertion order and ids are inserted in arrival order, so
  // the first key is always the oldest. `set` on a key that already exists does
  // NOT move it, but an id is only ever remembered once, so that cannot arise.
  while (seen.size > SEEN_MESSAGE_MAX_PER_SESSION) {
    const oldest = seen.keys().next();
    if (oldest.done) break;
    seen.delete(oldest.value);
  }
}

/**
 * Whether this id has already been accepted for this session.
 *
 * An empty id — a client predating the ack — is never a duplicate, so those
 * clients keep exactly the old behaviour.
 */
export function hasSeenClientMessage(
  sessionId: string,
  clientMessageId: string,
  now: number = Date.now(),
): boolean {
  if (!clientMessageId) return false;
  const seen = seenClientMessageIds.get(sessionId);
  if (!seen) return false;
  prune(seen, now);
  if (seen.size === 0) {
    // Nothing left worth tracking; drop the session's bucket so the outer map
    // does not accumulate an empty Map per session for the process lifetime.
    seenClientMessageIds.delete(sessionId);
    return false;
  }
  return seen.has(clientMessageId);
}

/**
 * Records an id as accepted.
 *
 * Call ONLY once the server has actually taken ownership of the message. A send
 * rejected for `SERVER_DRAINING` or `QUEUE_FULL` must not burn its id, or the
 * client's perfectly legitimate retry would come back as a duplicate, receive a
 * false ack, and discard the only copy of the message.
 */
export function rememberClientMessage(
  sessionId: string,
  clientMessageId: string,
  now: number = Date.now(),
): void {
  if (!clientMessageId) return;
  let seen = seenClientMessageIds.get(sessionId);
  if (!seen) {
    seen = new Map<string, number>();
    seenClientMessageIds.set(sessionId, seen);
  }
  seen.set(clientMessageId, now);
  prune(seen, now);
}

/**
 * Forgets a session's accepted ids, or all of them when called with no session.
 *
 * Wired into session deletion so a deleted session's bucket goes with it, and
 * used by tests to isolate cases.
 */
export function forgetSeenClientMessages(sessionId?: string): void {
  if (sessionId === undefined) {
    seenClientMessageIds.clear();
    return;
  }
  seenClientMessageIds.delete(sessionId);
}

/** Number of ids currently remembered for a session. Exposed for tests. */
export function seenClientMessageCount(sessionId: string): number {
  return seenClientMessageIds.get(sessionId)?.size ?? 0;
}

/** Number of sessions currently holding any state. Exposed for leak tests. */
export function trackedSessionCount(): number {
  return seenClientMessageIds.size;
}
