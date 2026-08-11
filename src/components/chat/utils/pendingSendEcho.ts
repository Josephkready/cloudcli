// Decides which pending sends the server actually received (#325).
//
// Kept separate from `pendingSends.ts` so that module stays a dependency-free
// store over plain data. This is the seam where a stored entry is matched
// against the persisted transcript, and it deliberately reuses
// `hasServerEchoForLocalUser` — the SAME matcher the message list uses to retire
// optimistic bubbles. One matcher for both means "the bubble disappeared" and
// "the message is confirmed" can never disagree, which is what would otherwise
// produce either a duplicate send or a message shown as delivered twice.

import { hasServerEchoForLocalUser, type NormalizedMessage } from '../../../stores/useSessionStore.pure';

import { partitionPendingSends, type PendingSend } from './pendingSends';

/**
 * Projects a stored entry into the minimal `NormalizedMessage` the echo matcher
 * reads: it looks only at `kind`, `role`, `content` and `timestamp`.
 *
 * `provider` is deliberately not plumbed through — the comparison never reads
 * it, and threading a value only to satisfy the type would mean inventing one
 * at every call site.
 */
export function pendingSendAsMessage(entry: PendingSend, sessionId: string): NormalizedMessage {
  return {
    id: entry.id,
    sessionId,
    timestamp: entry.timestamp,
    kind: 'text',
    role: 'user',
    content: entry.content,
  } as unknown as NormalizedMessage;
}

/**
 * Splits a session's pending sends by whether the server transcript proves they
 * arrived.
 *
 * `unconfirmed` is the resend set. Note this is the only check that catches a
 * half-open socket, where the send reported success and the frame was still
 * lost — at send time that case is indistinguishable from a delivered message,
 * so the transcript is the only evidence available.
 */
export function resolvePendingSends(
  entries: PendingSend[],
  serverMessages: NormalizedMessage[],
  sessionId: string,
): { confirmed: PendingSend[]; unconfirmed: PendingSend[] } {
  return partitionPendingSends(entries, (entry) =>
    hasServerEchoForLocalUser(pendingSendAsMessage(entry, sessionId), serverMessages),
  );
}
