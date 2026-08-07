import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TERMINAL_BACKGROUND_COLOR,
  TERMINAL_BUILD_FALLBACK_DELAY_MS,
  TERMINAL_OPTIONS,
  TERMINAL_SURFACE_STYLE,
  WEBGL_UPGRADE_FALLBACK_DELAY_MS,
  WEBGL_UPGRADE_IDLE_TIMEOUT_MS,
} from './constants';

/*
 * #246: the Shell wrapper and the xterm canvas used to carry two independent
 * hardcoded greys (#111827 vs #1e1e1e), which framed the terminal in a band of
 * the wrong colour. These lock the two together so re-inlining a hex on either
 * side fails here rather than in a screenshot.
 */

test('the xterm theme background is driven by the shared terminal colour', () => {
  assert.equal(TERMINAL_OPTIONS.theme?.background, TERMINAL_BACKGROUND_COLOR);
});

test('the cursor accent matches the background so the cursor stays legible', () => {
  assert.equal(TERMINAL_OPTIONS.theme?.cursorAccent, TERMINAL_BACKGROUND_COLOR);
});

test('the wrapper surface style paints the same colour as the terminal', () => {
  assert.equal(TERMINAL_SURFACE_STYLE.backgroundColor, TERMINAL_OPTIONS.theme?.background);
});

/*
 * #295: these three lived as bare literals inside `useShellTerminal.ts` while
 * every other shell timing constant lived here. They are ordering constraints,
 * not arbitrary numbers, so the relationships get pinned rather than the values.
 */

test('the build backstop fires within a frame or two, not after a visible stall', () => {
  // A hidden document never paints, so this is the only path that builds the
  // terminal there — long enough to lose the race to rAF when there IS a paint,
  // short enough that a background tab still comes up promptly.
  assert.ok(TERMINAL_BUILD_FALLBACK_DELAY_MS > 16);
  assert.ok(TERMINAL_BUILD_FALLBACK_DELAY_MS <= 250);
});

test('the WebGL upgrade waits longer than the terminal build backstop', () => {
  // The upgrade is deliberately behind the first paint and the pty handshake:
  // forcing it earlier is what made opening a shell feel slow (#272).
  assert.ok(WEBGL_UPGRADE_FALLBACK_DELAY_MS > TERMINAL_BUILD_FALLBACK_DELAY_MS);
});

test('the idle deadline is the outer bound on the DOM renderer, not the common case', () => {
  assert.ok(WEBGL_UPGRADE_IDLE_TIMEOUT_MS > WEBGL_UPGRADE_FALLBACK_DELAY_MS);
});
