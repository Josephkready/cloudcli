// Resend decision for pending chat messages after a reconnect (#325).
//
// Pure orchestration over injected effects, so the whole confirm-or-resend
// policy is unit-testable without a socket, a store, or localStorage.

import type { NormalizedMessage } from '../../../stores/useSessionStore.pure';

import { resolvePendingSends } from './pendingSendEcho';
import { retimePendingSend, type PendingSend } from './pendingSends';

/**
 * How long a message that DID reach a socket is presumed in flight before a
 * resend is considered.
 *
 * The transcript is written by the provider and picked up by the JSONL indexer,
 * which lags — the store comments on this directly ("common right after
 * `complete`, while JSONL indexing lags"). Inside that lag a delivered message
 * is genuinely absent from `serverMessages`, so resending on its absence alone
 * would duplicate it. That is not a harmless duplicate either: the server
 * appends a second `chat.send` to a per-session FIFO and dispatches it once the
 * current run finishes, so the user gets the same message asked twice.
 *
 * Only the ambiguous case waits. An entry the socket refused is known not to
 * have arrived and is resent immediately.
 */
export const DISPATCHED_RESEND_GRACE_MS = 30_000;

export type RetryPendingSendsArgs = {
  sessionId: string;
  /** The transcript as of the refresh that just completed. */
  serverMessages: NormalizedMessage[];
  entries: PendingSend[];
  /** Returns false when the frame was not written, so the entry stays pending. */
  send: (message: unknown) => boolean;
  /** Persists the new pending list (already restamped for anything resent). */
  persist: (entries: PendingSend[]) => void;
  /** Injected for determinism in tests. */
  now: () => number;
  /**
   * Whether `serverMessages` is the whole transcript rather than a page of it.
   *
   * The caller refetches with `limit: MESSAGES_PER_PAGE, offset: 0`, so what
   * arrives here is a window over the most recent messages. On a session with
   * more messages than fit, the opening prompt is simply not in it — and
   * treating that absence as "the server never received it" resent a message the
   * server had held for eighteen minutes (#347/#350). It is why the duplicate
   * was always the session's *first* message.
   *
   * Defaults to `true` so an omitted flag keeps the original behaviour.
   */
  transcriptComplete?: boolean;
};

/**
 * Confirms what the transcript already has and resends the rest.
 *
 * Ordering matters: entries are resent oldest-first so a burst typed during an
 * outage arrives in the order it was written.
 *
 * A resend that fails (socket dropped again mid-drain) keeps its entry pending
 * with its ORIGINAL timestamp — restamping only happens for frames actually
 * written, so a message that never left cannot have its echo window shifted
 * away from the transcript entry it will eventually produce.
 */
export function retryPendingSends({
  sessionId,
  serverMessages,
  entries,
  send,
  persist,
  now,
  transcriptComplete = true,
}: RetryPendingSendsArgs): { confirmed: number; resent: number; stillPending: number } {
  if (entries.length === 0) {
    return { confirmed: 0, resent: 0, stillPending: 0 };
  }

  // How far back the loaded slice actually reaches. On a partial transcript,
  // anything sent before this is simply outside the window we fetched, so its
  // absence proves nothing and must not trigger a resend. `Infinity` for an
  // empty partial slice: it covers nothing at all.
  const coveredFrom = transcriptComplete
    ? -Infinity
    : serverMessages.reduce((oldest, message) => {
      const time = Date.parse(message.timestamp);
      return Number.isFinite(time) ? Math.min(oldest, time) : oldest;
    }, Infinity);

  const { confirmed, unconfirmed } = resolvePendingSends(
    entries,
    serverMessages,
    sessionId,
  );

  const remaining: PendingSend[] = [];
  let resent = 0;
  let socketLost = false;
  const at = now();

  for (const entry of unconfirmed) {
    if (socketLost) {
      // Stop dispatching once the socket has failed: continuing would reorder
      // the queue relative to what actually got through.
      remaining.push(entry);
      continue;
    }

    // The loaded slice never reached back this far, so "not found" is a gap in
    // what we fetched, not evidence of loss. Hold the entry for a later pass
    // against a transcript that does cover it (#347/#350).
    //
    // This does not strand a genuinely lost message: the reconnect pass in
    // `ChatInterface` runs against `refreshFromServer`, which fetches the whole
    // transcript, so it judges the entry properly and resends if it really is
    // missing. Holding is the right side to err on — resending a message the
    // server already has asks the model the same thing twice, in front of the
    // user, whereas waiting costs one reconnect.
    const firstAttemptAt = Date.parse(entry.firstAttemptAt ?? entry.timestamp);
    if (Number.isFinite(firstAttemptAt) && firstAttemptAt < coveredFrom) {
      remaining.push(entry);
      continue;
    }

    // Absent `dispatched` is read as true — the conservative case, which waits.
    const wasDispatched = entry.dispatched !== false;
    const age = at - Date.parse(entry.timestamp);
    if (wasDispatched && age < DISPATCHED_RESEND_GRACE_MS) {
      // Still plausibly in flight or merely un-indexed. Keep it pending and let
      // a later pass decide, rather than risk asking the model the same thing
      // twice.
      remaining.push(entry);
      continue;
    }

    const dispatched = send({
      type: 'chat.send',
      sessionId,
      content: entry.content,
      options: { ...(entry.options ?? {}), images: [] },
      // Lets the server's ack confirm this entry by id, so a resend that lands
      // is retired on acknowledgement rather than waiting on the transcript
      // (#389).
      clientMessageId: entry.id,
    });

    if (dispatched) {
      resent += 1;
      // Restamped AND marked dispatched: this attempt is now the one whose echo
      // we are waiting for, and it starts its own grace period.
      remaining.push({ ...retimePendingSend(entry, new Date(at).toISOString()), dispatched: true });
    } else {
      socketLost = true;
      // Keep `dispatched: false` — still known not to have arrived, so the next
      // pass may retry it without waiting.
      remaining.push({ ...entry, dispatched: false });
    }
  }

  persist(remaining);
  return { confirmed: confirmed.length, resent, stillPending: remaining.length };
}
