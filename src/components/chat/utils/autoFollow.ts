/**
 * Auto-follow: the rule that pins the message pane to the newest message while
 * a run streams in, and — more importantly — the rules that give the viewport
 * back to the reader the moment they touch it.
 *
 * The arithmetic lives here, free of React and the DOM, because the failure it
 * guards against is a race (#333): a scroll-to-bottom is scheduled when a
 * message lands, and by the time it fires the reader may already be dragging
 * the pane upward. Deciding "should we still follow?" at *fire* time rather
 * than at *schedule* time is the whole fix, and it is only testable if the
 * decision is a pure function of the state it reads.
 */

/**
 * How close to the bottom still counts as "reading the newest message".
 *
 * Also the threshold behind the scroll-to-bottom button, so it is deliberately
 * generous — a streaming pane grows under the reader and a few pixels of drift
 * should not read as "scrolled away".
 */
export const NEAR_BOTTOM_THRESHOLD_PX = 50;

/**
 * How close to the bottom counts as *pinned* there — tight, because this is
 * what re-arms following after the reader has taken control. Re-arming on the
 * generous threshold above would resume yanking them down from 49px away.
 */
export const PINNED_TO_BOTTOM_PX = 4;

/**
 * Upward travel within one scroll event that reads as deliberate intent.
 *
 * A touch drag is sampled in small increments, so this is only a noise floor —
 * it exists so that a sub-pixel jitter or a rubber-band settle does not count
 * as the reader taking control.
 */
export const UPWARD_INTENT_PX = 2;

/**
 * Longest a single touch gesture is credited before the pointer gate expires.
 *
 * The gate is released by `touchend`/`touchcancel`, and a sequence that somehow
 * delivers neither — an OS gesture or a system dialog stealing the touch — would
 * otherwise leave it stuck on, silently disabling auto-follow for the rest of
 * the session. Well beyond any real drag, so it only ever fires on a gesture
 * that never ended.
 */
export const MAX_GESTURE_MS = 10_000;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Is a touch still credibly in progress? Guards against a gate that never got released. */
export function isGestureActive(input: {
  pointerDown: boolean;
  startedAt: number;
  now: number;
}): boolean {
  if (!input.pointerDown) return false;
  return input.now - input.startedAt < MAX_GESTURE_MS;
}

/** Pixels of content still below the viewport. Never negative (iOS overscrolls). */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight, 0);
}

export function isNearBottom(
  metrics: ScrollMetrics,
  threshold: number = NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottom(metrics) < threshold;
}

/**
 * Should this scroll event suspend auto-follow?
 *
 * The `isNearBottom` threshold alone is not enough on a phone. A deliberate but
 * short drag — 20px, well inside the 50px band — left auto-follow armed, so the
 * next message of a streaming run snapped the reader back to the bottom, and
 * the one after that, for as long as the run lasted. Treating any upward drag
 * *made with a finger on the glass* as intent is what stops the fight; the
 * pointer condition keeps programmatic scrolls (which move `scrollTop` too)
 * from suspending following.
 */
export function shouldSuspendAutoFollow(input: {
  previousScrollTop: number;
  metrics: ScrollMetrics;
  pointerDown: boolean;
}): boolean {
  if (!isNearBottom(input.metrics)) return true;
  if (!input.pointerDown) return false;
  return input.metrics.scrollTop < input.previousScrollTop - UPWARD_INTENT_PX;
}

/**
 * Should this scroll event *re-arm* auto-follow?
 *
 * Only being pinned at the very bottom counts, so a reader who stopped 30px up
 * stays where they put themselves.
 */
export function shouldResumeAutoFollow(metrics: ScrollMetrics): boolean {
  return distanceFromBottom(metrics) <= PINNED_TO_BOTTOM_PX;
}

/**
 * The fire-time check for a scheduled follow. Every input is read fresh from a
 * ref at the moment the timer runs, never captured when it was scheduled.
 */
export function shouldFollowNewMessages(state: {
  pointerDown: boolean;
  autoFollowSuspended: boolean;
  userScrolledUp: boolean;
}): boolean {
  // A finger on the glass outranks everything: moving the pane mid-gesture is
  // the jump the reader feels, and iOS keeps its own momentum running through
  // a programmatic `scrollTop` write.
  if (state.pointerDown) return false;
  if (state.autoFollowSuspended) return false;
  return !state.userScrolledUp;
}
