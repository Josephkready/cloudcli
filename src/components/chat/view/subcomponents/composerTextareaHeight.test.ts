import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeComposerTextareaMaxHeight,
  COMPOSER_CHROME_RESERVE_PX,
  COMPOSER_TEXTAREA_MIN_HEIGHT_PX,
} from './composerTextareaHeight';

/**
 * cloudcli#475: the textarea's growth cap used to be two static classes
 * (`max-h-[40vh] sm:max-h-[300px]`) blind to the keyboard and to a short
 * (landscape) viewport. These tests pin the generated CSS expression rather
 * than real layout (no CSS engine in this node:test suite) — see
 * `e2e/mobile-landscape-composer.spec.ts` for the browser-level geometry
 * assertions this is meant to satisfy.
 */

test('default call references --keyboard-height, 100dvh, and both original static ceilings', () => {
  const value = computeComposerTextareaMaxHeight();
  assert.match(value, /var\(--keyboard-height, 0px\)/);
  assert.match(value, /100dvh/);
  assert.match(value, /300px/);
  assert.match(value, /40vh/);
});

test('default call embeds the default reserve and floor constants', () => {
  const value = computeComposerTextareaMaxHeight();
  assert.match(value, new RegExp(`${COMPOSER_CHROME_RESERVE_PX}px\\)\\)\\)$`));
  assert.match(value, new RegExp(`^max\\(${COMPOSER_TEXTAREA_MIN_HEIGHT_PX}px,`));
});

test('a custom reserve/floor overrides the defaults', () => {
  const value = computeComposerTextareaMaxHeight({ chromeReservePx: 200, minHeightPx: 10 });
  assert.match(value, /200px\)\)\)$/);
  assert.match(value, /^max\(10px,/);
  assert.doesNotMatch(value, new RegExp(`${COMPOSER_CHROME_RESERVE_PX}px`));
});

test('is a min() of the two original static ceilings and the dynamic term, wrapped in a floor — never widens the pre-existing cap', () => {
  const value = computeComposerTextareaMaxHeight();
  // Structural check: `min(300px, 40vh, calc(...))` inside `max(<floor>, ...)`.
  // Because it's a min alongside 300px/40vh, a tall keyboard-free viewport
  // (where the calc() term is large) still resolves to whichever of the
  // original two terms is smaller there — pixel-identical to before this fix.
  assert.match(value, /^max\(\d+px, min\(300px, 40vh, calc\(/);
});
