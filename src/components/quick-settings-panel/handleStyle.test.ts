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

test('desktop: default position produces a keyboard-aware, reserve-floored top with vertical centring', () => {
  const style = computeHandleStyle({ isMobile: false, handlePosition: 50 });
  assert.equal(
    style.top,
    `min(50%, calc(100% - var(--keyboard-height, 0px) - ${HANDLE_KEYBOARD_RESERVE_PX}px))`,
  );
  assert.equal(style.transform, 'translateY(-50%)');
  assert.equal(style.bottom, undefined);
});

test('desktop: a custom reservedBottomPx is reflected in the min() ceiling', () => {
  const style = computeHandleStyle({ isMobile: false, handlePosition: 75, reservedBottomPx: 40 });
  assert.equal(style.top, 'min(75%, calc(100% - var(--keyboard-height, 0px) - 40px))');
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
