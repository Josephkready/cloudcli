import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NEAR_BOTTOM_THRESHOLD_PX,
  distanceFromBottom,
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

test('a short upward drag suspends following even inside the near-bottom band', () => {
  // 20px up from the bottom: still "near bottom", so the old threshold-only
  // rule kept following armed and the next message yanked the reader back.
  assert.equal(
    shouldSuspendAutoFollow({
      previousScrollTop: AT_BOTTOM,
      metrics: metrics(AT_BOTTOM - 20),
      pointerDown: true,
    }),
    true,
  );
});

test('a programmatic scroll does not suspend following', () => {
  // Same movement, no finger on the glass — this is the follow itself, or a
  // layout settle. Treating it as intent would disable following permanently.
  assert.equal(
    shouldSuspendAutoFollow({
      previousScrollTop: AT_BOTTOM,
      metrics: metrics(AT_BOTTOM - 20),
      pointerDown: false,
    }),
    false,
  );
});

test('sub-pixel jitter under a resting finger is not intent', () => {
  assert.equal(
    shouldSuspendAutoFollow({
      previousScrollTop: AT_BOTTOM,
      metrics: metrics(AT_BOTTOM - 1),
      pointerDown: true,
    }),
    false,
  );
});

test('scrolling clear of the band suspends following with or without a pointer', () => {
  for (const pointerDown of [true, false]) {
    assert.equal(
      shouldSuspendAutoFollow({
        previousScrollTop: AT_BOTTOM,
        metrics: metrics(AT_BOTTOM - 300),
        pointerDown,
      }),
      true,
    );
  }
});

test('scrolling downward never suspends following', () => {
  assert.equal(
    shouldSuspendAutoFollow({
      previousScrollTop: AT_BOTTOM - 40,
      metrics: metrics(AT_BOTTOM),
      pointerDown: true,
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
