import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_GESTURE_MS,
  NEAR_BOTTOM_THRESHOLD_PX,
  PINNED_TO_BOTTOM_PX,
  UPWARD_INTENT_PX,
  distanceFromBottom,
  isGestureActive,
  isNearBottom,
  shouldFollowNewMessages,
  shouldResumeAutoFollow,
  shouldSuspendAutoFollow,
  type ScrollMetrics,
} from './autoFollow';

/*
 * #333: "you start scrolling and it jumps, maybe when message is finished
 * streaming."
 *
 * Two things made the pane fight the reader on a phone:
 *
 *  1. The follow was scheduled when a message landed and fired 50ms later
 *     without re-checking anything. A drag started inside that window was
 *     undone — one visible jump, right as you start scrolling.
 *  2. Control was inferred solely from the 50px "near bottom" band. A short,
 *     deliberate drag stays inside it, so following remained armed and *every*
 *     message of a streaming run snapped the reader back down.
 *
 * The fire-time predicate below is the fix for (1); the pointer-aware
 * suspension is the fix for (2).
 */

const metrics = (scrollTop: number, scrollHeight = 1000, clientHeight = 600): ScrollMetrics => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

// scrollHeight 1000, clientHeight 600 -> the bottom is scrollTop 400.
const AT_BOTTOM = 400;

test('distanceFromBottom never goes negative when iOS overscrolls past the end', () => {
  assert.equal(distanceFromBottom(metrics(AT_BOTTOM)), 0);
  assert.equal(distanceFromBottom(metrics(AT_BOTTOM + 80)), 0);
  assert.equal(distanceFromBottom(metrics(AT_BOTTOM - 120)), 120);
});

test('isNearBottom spans the documented threshold', () => {
  assert.equal(isNearBottom(metrics(AT_BOTTOM - (NEAR_BOTTOM_THRESHOLD_PX - 1))), true);
  assert.equal(isNearBottom(metrics(AT_BOTTOM - NEAR_BOTTOM_THRESHOLD_PX)), false);
});

test('a short upward scroll off the bottom suspends following, with or without a pointer (#508)', () => {
  // 20px up from the bottom: still "near bottom", so the old threshold-only rule
  // kept following armed and the next chunk yanked the reader back. The absence
  // of a `pointerDown` field is itself the #508 regression assertion: the old
  // signature required it and short-circuited to "don't suspend" when it was
  // falsy, so a mouse wheel-up or a finger-lifted flick never suspended. Now any
  // upward move that lands off the bottom is intent regardless of pointer state.
  assert.equal(
    shouldSuspendAutoFollow({
      previousScrollTop: AT_BOTTOM,
      metrics: metrics(AT_BOTTOM - 20),
    }),
    true,
  );
});

test('a rubber-band settle that lands back at the bottom does not suspend', () => {
  // Overscroll past the bottom then release: `scrollTop` snaps UP to the bottom.
  // handleScroll sees the raw `scroll` event, so this reaches shouldSuspend with
  // no pointer — but it LANDS within PINNED_TO_BOTTOM_PX of the bottom, so it is
  // a settle, not a read-up, and following must stay armed.
  assert.equal(
    shouldSuspendAutoFollow({
      previousScrollTop: AT_BOTTOM + 30, // overscrolled past the bottom
      metrics: metrics(AT_BOTTOM),       // settled back exactly at the bottom
    }),
    false,
  );
});

test('sub-pixel jitter is not intent', () => {
  assert.equal(
    shouldSuspendAutoFollow({
      previousScrollTop: AT_BOTTOM,
      metrics: metrics(AT_BOTTOM - 1),
    }),
    false,
  );
});

test('scrolling clear of the band suspends following', () => {
  assert.equal(
    shouldSuspendAutoFollow({
      previousScrollTop: AT_BOTTOM,
      metrics: metrics(AT_BOTTOM - 300),
    }),
    true,
  );
});

test('scrolling downward never suspends following', () => {
  assert.equal(
    shouldSuspendAutoFollow({
      previousScrollTop: AT_BOTTOM - 40,
      metrics: metrics(AT_BOTTOM),
    }),
    false,
  );
});

test('following only re-arms when the reader is pinned at the very bottom', () => {
  assert.equal(shouldResumeAutoFollow(metrics(AT_BOTTOM)), true);
  assert.equal(shouldResumeAutoFollow(metrics(AT_BOTTOM - 4)), true);
  // Inside the near-bottom band but deliberately parked: leave them alone.
  assert.equal(shouldResumeAutoFollow(metrics(AT_BOTTOM - 30)), false);
});

test('a finger on the glass outranks every other follow condition', () => {
  assert.equal(
    shouldFollowNewMessages({ pointerDown: true, autoFollowSuspended: false, userScrolledUp: false }),
    false,
  );
});

test('a suspended follow stays suspended even while near the bottom', () => {
  assert.equal(
    shouldFollowNewMessages({ pointerDown: false, autoFollowSuspended: true, userScrolledUp: false }),
    false,
  );
});

test('a reader who scrolled away is not pulled back', () => {
  assert.equal(
    shouldFollowNewMessages({ pointerDown: false, autoFollowSuspended: false, userScrolledUp: true }),
    false,
  );
});

test('an untouched pane pinned at the bottom still follows the run', () => {
  assert.equal(
    shouldFollowNewMessages({ pointerDown: false, autoFollowSuspended: false, userScrolledUp: false }),
    true,
  );
});

// Exact boundaries — an off-by-one in the comparisons above would otherwise slip
// through, since every other case sits comfortably to one side.

test('upward intent is measured strictly beyond the noise floor', () => {
  // Start 10px off the bottom — inside the near-bottom band, but past the pinned
  // threshold so the rubber-band landing guard is not in play — to isolate the
  // upward-movement noise floor itself.
  const base = AT_BOTTOM - 10;
  const drag = (delta: number) => shouldSuspendAutoFollow({
    previousScrollTop: base,
    metrics: metrics(base - delta),
  });
  assert.equal(drag(UPWARD_INTENT_PX), false);
  assert.equal(drag(UPWARD_INTENT_PX + 1), true);
});

test('following re-arms exactly at the pinned threshold and not a pixel past it', () => {
  assert.equal(shouldResumeAutoFollow(metrics(AT_BOTTOM - PINNED_TO_BOTTOM_PX)), true);
  assert.equal(shouldResumeAutoFollow(metrics(AT_BOTTOM - (PINNED_TO_BOTTOM_PX + 1))), false);
});

test('a released pointer is never an active gesture', () => {
  assert.equal(isGestureActive({ pointerDown: false, startedAt: 0, now: 0 }), false);
  assert.equal(isGestureActive({ pointerDown: false, startedAt: 0, now: MAX_GESTURE_MS * 10 }), false);
});

test('a gesture in progress holds the gate', () => {
  assert.equal(isGestureActive({ pointerDown: true, startedAt: 1000, now: 1000 }), true);
  assert.equal(isGestureActive({ pointerDown: true, startedAt: 1000, now: 1000 + MAX_GESTURE_MS - 1 }), true);
});

test('a gesture that never ended expires instead of wedging the gate on forever', () => {
  // touchend/touchcancel releases the gate in practice. If a sequence delivers
  // neither — an OS gesture stealing the touch — the gate must not disable
  // auto-follow for the rest of the session.
  assert.equal(isGestureActive({ pointerDown: true, startedAt: 1000, now: 1000 + MAX_GESTURE_MS }), false);
  assert.equal(isGestureActive({ pointerDown: true, startedAt: 0, now: MAX_GESTURE_MS * 100 }), false);
});
