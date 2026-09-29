import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAnchoredScrollTop, resolveRestoreScrollTop, type ScrollRestoreState } from './scrollRestore';

/*
 * Prepending older messages moves everything the user was looking at down the
 * page, so the raw scroll offset is meaningless afterwards. Two different
 * intents share that mechanism, and #317 is what happens when they are
 * conflated:
 *
 *  - 'preserve' — an incremental load-more (scrolling to the top pulls in the
 *    next page). The user is reading; keep the same content under their eyes.
 *  - 'toStart' — the explicit "Load all messages (N)" button. The user asked
 *    to see the whole thread, so land them at its beginning. Preserving here
 *    is what reads as "it only scrolls up a little" (#317): every older
 *    message arrives, but the viewport stays pinned to the message they were
 *    already on.
 */

const preserve = (top: number, height: number): ScrollRestoreState => ({
  mode: 'preserve',
  top,
  height,
});

test('preserve keeps the same content under the viewport after a prepend', () => {
  // 400px of older content arrived above the viewport, so the offset that
  // still points at the same message is 500 + 400.
  assert.equal(resolveRestoreScrollTop(preserve(500, 1000), 1400), 900);
});

test('preserve is a no-op when the content did not grow', () => {
  assert.equal(resolveRestoreScrollTop(preserve(500, 1000), 1000), 500);
});

test('preserve never scrolls backwards if the content shrank', () => {
  // A shrinking container would otherwise produce a negative delta and yank
  // the user upward.
  assert.equal(resolveRestoreScrollTop(preserve(500, 1000), 800), 500);
});

test('toStart lands at the beginning of the thread regardless of prior offset (#317)', () => {
  assert.equal(
    resolveRestoreScrollTop({ mode: 'toStart', top: 500, height: 1000 }, 40_000),
    0,
  );
});

test('toStart lands at the beginning even from the very top of a short thread', () => {
  assert.equal(resolveRestoreScrollTop({ mode: 'toStart', top: 0, height: 200 }, 200), 0);
});

/*
 * cloudcli B1: the raw scrollHeight/scrollTop delta above assumes the
 * newly-prepended rows already have their final measured height by the time
 * it runs, and that the reader hasn't scrolled since the pre-fetch snapshot
 * was taken. Anchoring to a specific row's live position holds regardless of
 * either.
 */

test('resolveAnchoredScrollTop keeps the anchor row at the same offset below the top edge', () => {
  // The anchor sat 120px below the container's top edge at capture time. The
  // prepend pushed its rect down to 640px; landing back at +120 needs the
  // scrollTop nudged forward by exactly that 520px delta.
  assert.equal(
    resolveAnchoredScrollTop({
      currentScrollTop: 900,
      anchorElementTop: 640,
      anchor: { key: 'message-user-42', offset: 120 },
      maxScrollTop: 10_000,
    }),
    1420,
  );
});

test('resolveAnchoredScrollTop is a no-op when the anchor has not moved', () => {
  assert.equal(
    resolveAnchoredScrollTop({
      currentScrollTop: 500,
      anchorElementTop: 50,
      anchor: { key: 'message-user-1', offset: 50 },
      maxScrollTop: 10_000,
    }),
    500,
  );
});

test('resolveAnchoredScrollTop never goes negative', () => {
  assert.equal(
    resolveAnchoredScrollTop({
      currentScrollTop: 30,
      anchorElementTop: 0,
      anchor: { key: 'message-user-1', offset: 200 },
      maxScrollTop: 10_000,
    }),
    0,
  );
});

test('resolveAnchoredScrollTop never overshoots the container', () => {
  assert.equal(
    resolveAnchoredScrollTop({
      currentScrollTop: 100,
      anchorElementTop: 5_000,
      anchor: { key: 'message-user-1', offset: 0 },
      maxScrollTop: 400,
    }),
    400,
  );
});
