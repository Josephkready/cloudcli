import assert from 'node:assert/strict';
import test from 'node:test';

import { computeHandleStyle } from './handleStyle';
import { HANDLE_KEYBOARD_RESERVE_PX } from './constants';

/**
 * cloudcli#474: the drag handle used to be positioned from a JS-computed
 * pixel value derived from `window.innerHeight` alone. That went stale on any
 * resize and never accounted for the soft keyboard, so it could land on top
 * of the composer's send button. These tests pin the CSS-expression
 * replacement: every generated value must be keyboard-aware (reference
 * `--keyboard-height`) and floored by the reserved band, for both the mobile
 * and desktop drag ranges.
 */

test('mobile: default position (50%) produces a keyboard-aware bottom with the default reserve', () => {
  const style = computeHandleStyle({ isMobile: true, handlePosition: 50 });
  assert.equal(
    style.bottom,
    'max(calc(var(--keyboard-height, 0px) + 160px), calc(var(--keyboard-height, 0px) + (100% - var(--keyboard-height, 0px)) * 0.5))',
  );
  assert.equal(style.top, undefined);
});

test('mobile: minimum drag position (10%) still floors on the reserved band, not just the proportional term', () => {
  const style = computeHandleStyle({ isMobile: true, handlePosition: 10 });
  // Both candidates must be present — `max()` is what guarantees the handle
  // can never be dragged into the composer's territory even at rest, which
  // was possible before this fix (10% of a typical viewport is well inside
  // the reserved band).
  assert.match(style.bottom as string, /max\(/);
  assert.match(style.bottom as string, /\+ 160px\)/);
  assert.match(style.bottom as string, /\* 0\.1\)/);
});

test('mobile: maximum drag position (90%) still folds in the keyboard height', () => {
  const style = computeHandleStyle({ isMobile: true, handlePosition: 90 });
  assert.match(style.bottom as string, /var\(--keyboard-height, 0px\)/);
  assert.match(style.bottom as string, /\* 0\.9\)/);
});

test('mobile: a custom reservedBottomPx overrides the default in both max() branches', () => {
  const style = computeHandleStyle({ isMobile: true, handlePosition: 50, reservedBottomPx: 200 });
  assert.match(style.bottom as string, /\+ 200px\)/);
  assert.doesNotMatch(style.bottom as string, /\+ 160px\)/);
});

test('desktop: default position produces a keyboard-aware top with vertical centring', () => {
  const style = computeHandleStyle({ isMobile: false, handlePosition: 50 });
  assert.equal(style.top, 'min(50%, calc(100% - var(--keyboard-height, 0px)))');
  assert.equal(style.transform, 'translateY(-50%)');
  assert.equal(style.bottom, undefined);
});

test('desktop: reservedBottomPx does NOT affect the desktop ceiling', () => {
  // A real regression, caught in review: an earlier version subtracted
  // `reservedBottomPx` on desktop too, which silently compressed the normal
  // drag range on any window under ~1600px tall even with no keyboard in
  // sight (e.g. handlePosition=90 rendered at 80% on an 800px-tall window).
  // Desktop must be pixel-identical to the pre-fix `top: ${handlePosition}%`
  // whenever there is no keyboard — which the assertion below confirms
  // holds regardless of what `reservedBottomPx` is passed.
  const withDefault = computeHandleStyle({ isMobile: false, handlePosition: 90 });
  const withCustom = computeHandleStyle({ isMobile: false, handlePosition: 90, reservedBottomPx: 999 });
  assert.equal(withDefault.top, withCustom.top);
  assert.doesNotMatch(withDefault.top as string, /999px/);
  assert.doesNotMatch(withDefault.top as string, new RegExp(`${HANDLE_KEYBOARD_RESERVE_PX}px`));
});

test('desktop: with no keyboard, the ceiling never engages for any in-range handlePosition (matches pre-fix behaviour)', () => {
  // `min(X%, calc(100% - 0px))` is `X%` for any X <= 100 — i.e. a no-op vs.
  // the pre-fix `top: X%` — for every position the drag can actually reach
  // ([HANDLE_POSITION_MIN, HANDLE_POSITION_MAX] = [10, 90]). Asserted via the
  // generated string's shape rather than a CSS engine (none is available in
  // this node:test suite): the ceiling term is always exactly
  // `calc(100% - var(--keyboard-height, 0px))`, so it only ever subtracts
  // the live keyboard height, never a fixed reserve.
  for (const handlePosition of [10, 50, 90]) {
    const style = computeHandleStyle({ isMobile: false, handlePosition });
    assert.equal(style.top, `min(${handlePosition}%, calc(100% - var(--keyboard-height, 0px)))`);
  }
});

test('mobile: a fractional handlePosition (real drag math, not just round test values) rounds to 4 decimal places', () => {
  // Drag position comes from pixel-delta math (useQuickSettingsDrag.ts), so
  // production values are rarely round numbers, and raw floating-point
  // division produces noise (33.333 / 100 === 0.33332999999999996 in
  // IEEE-754). Rounding to 4 places keeps the generated CSS string sane
  // without any visible effect on layout.
  const style = computeHandleStyle({ isMobile: true, handlePosition: 33.333 });
  assert.match(style.bottom as string, /\* 0\.3333\)/);
  assert.doesNotMatch(style.bottom as string, /0\.33332999999999996/);
});

test('handlePosition/reservedBottomPx are not clamped by this function — callers must clamp first', () => {
  // useQuickSettingsDrag.ts always clamps handlePosition to
  // [HANDLE_POSITION_MIN, HANDLE_POSITION_MAX] (10-90) via clampPosition
  // before calling computeHandleStyle, so 0/100/negative inputs are not
  // reachable through the app today. Pinned here so that contract is
  // explicit rather than tribal knowledge: out-of-range input still produces
  // a syntactically valid CSS value on both branches, it is just not this
  // function's job to guard the range.
  const mobileAtZero = computeHandleStyle({ isMobile: true, handlePosition: 0 });
  assert.match(mobileAtZero.bottom as string, /\* 0\)/);

  const desktopAtHundred = computeHandleStyle({ isMobile: false, handlePosition: 100 });
  assert.equal(desktopAtHundred.top, 'min(100%, calc(100% - var(--keyboard-height, 0px)))');

  const negativeReserve = computeHandleStyle({ isMobile: true, handlePosition: 50, reservedBottomPx: -10 });
  assert.match(negativeReserve.bottom as string, /\+ -10px\)/);
});

test('every generated style references --keyboard-height, so the handle can never be keyboard-blind again', () => {
  for (const isMobile of [true, false]) {
    for (const handlePosition of [10, 50, 90]) {
      const style = computeHandleStyle({ isMobile, handlePosition });
      const value = String(isMobile ? style.bottom : style.top);
      assert.match(value, /var\(--keyboard-height, 0px\)/, `isMobile=${isMobile} handlePosition=${handlePosition}`);
    }
  }
});
