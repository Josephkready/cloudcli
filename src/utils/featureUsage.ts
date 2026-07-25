/**
 * Local feature-usage counting (issue #248).
 *
 * One line per instrumented entry point:
 *
 * ```ts
 * recordFeatureUse('git.commit');
 * ```
 *
 * The keys are the closed union in `shared/featureKeys.ts`, imported here as a
 * *type only* so the inventory costs the client bundle nothing.
 *
 * ## Best-effort by contract
 *
 * `recordFeatureUse` never throws and never returns a promise a caller could
 * forget to catch. A missing `fetch`, an offline server, a 500, a serialization
 * failure — none of it can propagate into the user action being counted. That
 * guarantee is why the whole body is wrapped and why the flush is fire-and-
 * forget rather than awaited.
 *
 * ## Why it batches
 *
 * Hits are coalesced into one POST every couple of seconds instead of a request
 * per click, so instrumenting a chatty surface can never turn into a request
 * storm. Counting is aggregate anyway — the server tallies the batch — so the
 * only thing the delay costs is a second or two of precision on `last_used_at`.
 */

import type { FeatureKey } from '../../shared/featureKeys';

import { authenticatedFetch } from './api';

const FLUSH_DELAY_MS = 2000;

let pendingKeys: FeatureKey[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Latched when the server reports `FEATURE_USAGE_ENABLED=false`. */
let recordingDisabled = false;
let unloadHookInstalled = false;

/** Ships whatever has accumulated. `keepalive` lets a page-unload flush land. */
const flush = (keepalive = false): void => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  const keys = pendingKeys;
  pendingKeys = [];
  if (keys.length === 0 || recordingDisabled) return;

  try {
    void authenticatedFetch('/api/usage', {
      method: 'POST',
      body: JSON.stringify({ keys }),
      keepalive,
    })
      .then((response) => response.json())
      .then((body: { enabled?: boolean } | null) => {
        // Honour the server-side off switch by going quiet, so disabling
        // recording stops the traffic and not just the writes.
        if (body?.enabled === false) recordingDisabled = true;
      })
      .catch(() => {
        // Counters are not worth surfacing a network error for.
      });
  } catch {
    // `fetch` missing entirely (non-browser runtime) lands here.
  }
};

const installUnloadHook = (): void => {
  if (unloadHookInstalled || typeof window === 'undefined') return;
  unloadHookInstalled = true;
  // `pagehide` fires for real navigations *and* for the bfcache path that
  // `beforeunload` misses, which matters on the iOS PWA this app targets.
  window.addEventListener('pagehide', () => flush(true));
};

const scheduleFlush = (): void => {
  installUnloadHook();
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => flush(), FLUSH_DELAY_MS);
  // Node's timers keep the process alive; the front-end unit runner (`tsx
  // --test`) would hang on a pending flush. Browsers return a number with no
  // `unref`, so this is a no-op there.
  (flushTimer as unknown as { unref?: () => void }).unref?.();
};

/**
 * Counts one use of a feature. Fire-and-forget, never throws.
 *
 * Call it at the point the user *commits* the action (the submit, the confirmed
 * click), not where a menu opens — an opened-then-abandoned menu is not usage.
 */
export const recordFeatureUse = (key: FeatureKey): void => {
  try {
    if (recordingDisabled) return;
    pendingKeys.push(key);
    scheduleFlush();
  } catch {
    // Best-effort by contract: never break the action being recorded.
  }
};

/** Test seam: flush synchronously and reset the latched state. */
export const __resetFeatureUsageForTests = (): void => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingKeys = [];
  recordingDisabled = false;
  unloadHookInstalled = false;
};

/** Test seam: force the pending batch out without waiting for the timer. */
export const __flushFeatureUsageForTests = (): void => flush();

/** Test seam: read the not-yet-flushed batch. */
export const __pendingFeatureUsesForTests = (): readonly FeatureKey[] => pendingKeys;
