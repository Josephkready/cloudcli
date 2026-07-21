import type { LLMProvider } from '@/shared/types.js';

export type WatcherEventType = 'add' | 'change';

/**
 * One coalesced window of watcher activity.
 *
 * `updatedSessionIds` holds provider-native session ids reported by the
 * synchronizers; they are translated back to app-facing session rows at flush
 * time, because the transcript file names on disk only ever contain provider
 * ids.
 */
export type SessionUpsertBatch = {
  providers: Set<LLMProvider>;
  changeTypes: Set<WatcherEventType>;
  updatedSessionIds: Set<string>;
};

export type SessionUpsertDebouncerOptions = {
  /** Quiet period a batch waits for after the most recent event. */
  debounceMs: number;
  /** Hard ceiling on how long the first event of a batch can be held back. */
  maxWaitMs: number;
  onFlush: (batch: SessionUpsertBatch) => void | Promise<void>;
  onError?: (error: unknown) => void;
};

export type SessionUpsertDebouncer = {
  queue: (eventType: WatcherEventType, provider: LLMProvider, updatedSessionId: string | null) => void;
  /** Flushes whatever is queued right now, bypassing the remaining debounce. */
  flush: () => Promise<void>;
  /** Drops any queued batch and pending timer without flushing. */
  reset: () => void;
  hasPendingBatch: () => boolean;
};

/**
 * Debounce/flush state machine behind the `session_upserted` broadcasts.
 *
 * A single transcript write produces a burst of watcher events, so events are
 * coalesced into one batch per quiet period. Two invariants matter and are the
 * reason this lives in its own module with its own tests (#104):
 *
 *  - **Nothing is dropped.** Events arriving while a flush is in flight start a
 *    fresh batch, and the in-flight flush reschedules itself on the way out so
 *    that batch is always delivered.
 *  - **Nothing is delivered twice.** Only one flush runs at a time, and a batch
 *    is detached from the queue before `onFlush` is awaited, so a re-entrant
 *    flush can never re-send it.
 *
 * `maxWaitMs` bounds the starvation case: under a steady stream of events the
 * debounce would otherwise keep sliding forward and the batch would never land.
 */
export function createSessionUpsertDebouncer(
  options: SessionUpsertDebouncerOptions
): SessionUpsertDebouncer {
  const { debounceMs, maxWaitMs, onFlush } = options;
  const onError = options.onError
    ?? ((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Session watcher refresh failed while broadcasting session_upserted', { error: message });
    });

  let pendingBatch: SessionUpsertBatch | null = null;
  let pendingBatchStartedAt: number | null = null;
  let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushInFlight = false;

  function clearPendingFlushTimer(): void {
    if (pendingFlushTimer) {
      clearTimeout(pendingFlushTimer);
      pendingFlushTimer = null;
    }
  }

  function schedulePendingFlush(): void {
    if (!pendingBatch) {
      return;
    }

    const now = Date.now();
    if (pendingBatchStartedAt === null) {
      pendingBatchStartedAt = now;
    }

    const elapsed = now - pendingBatchStartedAt;
    const remainingMaxWait = Math.max(0, maxWaitMs - elapsed);
    const delay = Math.min(debounceMs, remainingMaxWait);

    clearPendingFlushTimer();
    pendingFlushTimer = setTimeout(() => {
      void flushPendingBatch();
    }, delay);
  }

  async function flushPendingBatch(): Promise<void> {
    clearPendingFlushTimer();

    if (!pendingBatch) {
      return;
    }

    if (flushInFlight) {
      // Whatever has been queued since the in-flight flush detached its own
      // batch is picked up by that flush's reschedule below, so dropping out
      // here loses nothing — whereas running concurrently would re-deliver the
      // batch already being broadcast.
      return;
    }

    const batch = pendingBatch;
    pendingBatch = null;
    pendingBatchStartedAt = null;
    flushInFlight = true;

    try {
      await onFlush(batch);
    } catch (error) {
      onError(error);
    } finally {
      flushInFlight = false;
      // Anything queued while this flush was awaiting is still sitting in
      // `pendingBatch` with no live timer (its timer either fired into the
      // in-flight guard above or was cleared there), so it has to be
      // rescheduled here or it would never be broadcast.
      schedulePendingFlush();
    }
  }

  return {
    queue(eventType, provider, updatedSessionId) {
      if (!pendingBatch) {
        pendingBatch = {
          providers: new Set<LLMProvider>(),
          changeTypes: new Set<WatcherEventType>(),
          updatedSessionIds: new Set<string>(),
        };
      }

      pendingBatch.providers.add(provider);
      pendingBatch.changeTypes.add(eventType);
      if (updatedSessionId) {
        pendingBatch.updatedSessionIds.add(updatedSessionId);
      }

      schedulePendingFlush();
    },
    flush: flushPendingBatch,
    reset() {
      clearPendingFlushTimer();
      pendingBatch = null;
      pendingBatchStartedAt = null;
      flushInFlight = false;
    },
    hasPendingBatch: () => pendingBatch !== null,
  };
}
