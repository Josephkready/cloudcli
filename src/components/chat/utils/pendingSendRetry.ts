// Resend decision for pending chat messages after a reconnect (#325).
//
// Pure orchestration over injected effects, so the whole confirm-or-resend
// policy is unit-testable without a socket, a store, or localStorage.

import type { NormalizedMessage } from '../../../stores/useSessionStore.pure';

import { resolvePendingSends } from './pendingSendEcho';
import { retimePendingSend, type PendingSend } from './pendingSends';

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
}: RetryPendingSendsArgs): { confirmed: number; resent: number; stillPending: number } {
  if (entries.length === 0) {
    return { confirmed: 0, resent: 0, stillPending: 0 };
  }

  const { confirmed, unconfirmed } = resolvePendingSends(
    entries,
    serverMessages,
    sessionId,
  );

  const remaining: PendingSend[] = [];
  let resent = 0;
  let socketLost = false;

  for (const entry of unconfirmed) {
    if (socketLost) {
      // Stop dispatching once the socket has failed: continuing would reorder
      // the queue relative to what actually got through.
      remaining.push(entry);
      continue;
    }

    const dispatched = send({
      type: 'chat.send',
      sessionId,
      content: entry.content,
      options: { ...(entry.options ?? {}), images: [] },
    });

    if (dispatched) {
      resent += 1;
      remaining.push(retimePendingSend(entry, new Date(now()).toISOString()));
    } else {
      socketLost = true;
      remaining.push(entry);
    }
  }

  persist(remaining);
  return { confirmed: confirmed.length, resent, stillPending: remaining.length };
}
