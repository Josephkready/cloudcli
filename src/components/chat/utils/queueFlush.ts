/**
 * Pure decision for the composer's queued-message flush effect: given the
 * current run/queue state, decide whether to flush the head of the queue now
 * and after how long. Extracted from the effect so the (easy-to-get-wrong)
 * gating is unit-testable without React.
 */
export type QueueFlushDecision = {
  /** Whether to dispatch the head of the queue. */
  flush: boolean;
  /** Delay before dispatching, in ms (ignored when `flush` is false). */
  delayMs: number;
};

const NO_FLUSH: QueueFlushDecision = { flush: false, delayMs: 0 };

/**
 * Idle "is a run actually still live?" hold before flushing a restored queue,
 * giving a `chat_subscribed` ack time to flip `isLoading` first.
 */
export const IDLE_FLUSH_HOLD_MS = 750;

export function decideQueueFlush(params: {
  /** The viewed session changed on this render (queue belongs to the old one). */
  sessionChanged: boolean;
  /** A run is currently in flight for this session. */
  isLoading: boolean;
  /** A queued item's replay is already in flight (serialization guard). */
  isFlushing: boolean;
  /** Number of messages currently queued. */
  queueLength: number;
  /** `isLoading` on the previous render — true→false marks a completed run. */
  wasLoading: boolean;
}): QueueFlushDecision {
  const { sessionChanged, isLoading, isFlushing, queueLength, wasLoading } = params;

  // Never flush across a session switch, into a live run, on top of an
  // in-flight flush, or with nothing queued.
  if (sessionChanged || isLoading || isFlushing || queueLength === 0) {
    return NO_FLUSH;
  }

  // A run just completed in this session → drain the next item immediately.
  // Otherwise this is a restored/idle queue → hold briefly first.
  return { flush: true, delayMs: wasLoading ? 0 : IDLE_FLUSH_HOLD_MS };
}
