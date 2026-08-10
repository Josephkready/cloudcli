import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRestoreScrollTop, type ScrollRestoreState } from './scrollRestore';

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
