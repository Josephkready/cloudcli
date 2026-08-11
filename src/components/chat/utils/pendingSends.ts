// Durable record of chat messages that have been handed to the websocket but
// not yet confirmed by the server (#325).
//
// WHY THIS EXISTS. `chat.send` is fire-and-forget over a websocket, and the
// optimistic user bubble lives only in an in-memory store ("No localStorage for
// messages" — useSessionStore.ts). So a send that never reached the server left
// no trace anywhere: the bubble looked delivered until reload, the draft had
// already been cleared, and the message was simply gone.
//
// TWO WAYS A SEND IS LOST, and why persisting is the only thing that covers
// both:
//   1. The socket is closed. Detectable up front via `readyState`.
//   2. The socket is half-open — common on iOS when the connection drops or the
//      app is backgrounded. `readyState` still reads OPEN, `send()` succeeds
//      locally, and the frame evaporates into a dead TCP connection with no
//      `onerror` or `onclose` until the OS tears it down. NOTHING observable at
//      send time distinguishes this from success.
// Case 2 is why "check readyState and report failure" is not a fix on its own:
// the only reliable evidence a message arrived is the server echoing it back.
//
// So an entry is written here BEFORE the send and removed only once the server
// transcript proves it landed — see `partitionPendingSends`. Anything still
// unconfirmed after a reconnect is re-sent.
//
// Deliberately a separate key from `queued_message_<id>`: that queue holds
// messages knowingly NOT yet sent (a turn was already in flight), whereas these
// may or may not have reached the server, which is a different retry decision.
// Keeping them apart also keeps them out of the `QuotaExceededError` sweep in
// `safeLocalStorage`, which drops `draft_input_`/`queued_message_` keys — these
// entries are unconfirmed user writing and are the last thing worth discarding.

import { safeLocalStorage } from './chatStorage';

export type PendingSend = {
  /** Stable id so a confirmed entry can be removed without re-matching text. */
  id: string;
  content: string;
  /** ISO-8601, matching `NormalizedMessage.timestamp` so echo matching lines up. */
  timestamp: string;
  options?: Record<string, unknown>;
};

export const pendingSendKey = (sessionId: string) => `pending_send_${sessionId}`;

let pendingSendCounter = 0;

/**
 * Ids only need to be unique within one browser session's storage, so a counter
 * plus the clock is enough and keeps this dependency-free.
 */
export function makePendingSendId(): string {
  pendingSendCounter += 1;
  return `pending_${Date.now()}_${pendingSendCounter}`;
}

function normalizePendingSend(value: unknown): PendingSend | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { id, content, timestamp, options } = value as Partial<PendingSend>;
  if (typeof id !== 'string' || !id || typeof content !== 'string' || !content.trim()) {
    return null;
  }
  // A missing/garbled timestamp would make echo matching silently never match,
  // which would resend forever. Fall back to the epoch-free "unknown" case by
  // dropping the entry rather than risking an unbounded resend loop.
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    return null;
  }
  return options !== undefined && options !== null && typeof options === 'object'
    ? { id, content, timestamp, options: options as Record<string, unknown> }
    : { id, content, timestamp };
}

/** Parses the persisted list. Pure, so the storage layer needn't be stubbed. */
export function parsePendingSends(raw: string | null): PendingSend[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(normalizePendingSend)
      .filter((entry): entry is PendingSend => entry !== null);
  } catch {
    // Unlike the queued-message store there is no legacy raw-text format to
    // migrate — this key has only ever held JSON.
    return [];
  }
}

/** Serializes for storage. Returns `null` when the key should be removed. */
export function serializePendingSends(entries: PendingSend[]): string | null {
  const cleaned = entries
    .map(normalizePendingSend)
    .filter((entry): entry is PendingSend => entry !== null);
  return cleaned.length ? JSON.stringify(cleaned) : null;
}

export function readPendingSends(sessionId: string): PendingSend[] {
  return parsePendingSends(safeLocalStorage.getItem(pendingSendKey(sessionId)));
}

export function writePendingSends(sessionId: string, entries: PendingSend[]): void {
  const serialized = serializePendingSends(entries);
  if (serialized === null) {
    safeLocalStorage.removeItem(pendingSendKey(sessionId));
  } else {
    safeLocalStorage.setItem(pendingSendKey(sessionId), serialized);
  }
}

/** Records an outgoing message. Call BEFORE handing it to the socket. */
export function appendPendingSend(sessionId: string, entry: PendingSend): void {
  writePendingSends(sessionId, [...readPendingSends(sessionId), entry]);
}

/** Drops one entry by id — used once the server transcript proves it landed. */
export function removePendingSend(sessionId: string, id: string): void {
  writePendingSends(
    sessionId,
    readPendingSends(sessionId).filter((entry) => entry.id !== id),
  );
}

/**
 * Restamps an entry to the moment it is (re)sent.
 *
 * Echo matching compares the entry's timestamp against the server's, and only
 * accepts them as the same message inside a bounded window
 * (`LOCAL_USER_DEDUPE_WINDOW_MS`, 5 minutes). An entry that sat unsent through a
 * long outage would be written to the transcript far outside that window, its
 * echo would never match, and it would be resent on every reconnect forever.
 * Restamping at send time is what keeps a retry confirmable.
 */
export function retimePendingSend(entry: PendingSend, timestamp: string): PendingSend {
  return { ...entry, timestamp };
}

/**
 * Splits pending entries into those the server transcript already contains and
 * those it does not.
 *
 * `hasEcho` is injected rather than imported so this stays a pure function over
 * plain data (and so the caller supplies the SAME matcher the message list uses
 * to dedupe optimistic bubbles — `hasServerEchoForLocalUser`). Using one matcher
 * for both is what keeps "the bubble disappeared" and "the message is confirmed"
 * from ever disagreeing.
 */
export function partitionPendingSends(
  entries: PendingSend[],
  hasEcho: (entry: PendingSend) => boolean,
): { confirmed: PendingSend[]; unconfirmed: PendingSend[] } {
  const confirmed: PendingSend[] = [];
  const unconfirmed: PendingSend[] = [];
  for (const entry of entries) {
    (hasEcho(entry) ? confirmed : unconfirmed).push(entry);
  }
  return { confirmed, unconfirmed };
}
