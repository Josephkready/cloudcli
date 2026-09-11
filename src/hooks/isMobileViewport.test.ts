import assert from 'node:assert/strict';
import test from 'node:test';

import { computeIsMobile } from './isMobileViewport';

/**
 * cloudcli#475: a phone rotated to landscape (e.g. 844x390) is wider than the
 * 768px breakpoint, so the old width-only check put it in the desktop layout.
 * These tests pin the replacement: width still governs the common case, but a
 * coarse-pointer/no-hover device (touch, never a mouse) is mobile regardless of
 * width, and a mouse-driven desktop is never misclassified no matter how the
 * window is shaped.
 */

test('narrow width is mobile regardless of pointer/hover', () => {
  assert.equal(
    computeIsMobile({ width: 400, isCoarsePointer: false, hasNoHover: false }, 768),
    true,
  );
});

test('wide width with mouse/hover capability is desktop (the common case, unaffected)', () => {
  assert.equal(
    computeIsMobile({ width: 1440, isCoarsePointer: false, hasNoHover: false }, 768),
    false,
  );
});

test('wide width + coarse pointer + no hover is mobile (cloudcli#475: landscape phone, e.g. 844x390)', () => {
  assert.equal(
    computeIsMobile({ width: 844, isCoarsePointer: true, hasNoHover: true }, 768),
    true,
  );
});

test('wide width + coarse pointer but WITH hover is desktop (a hybrid touchscreen laptop with a mouse attached)', () => {
  assert.equal(
    computeIsMobile({ width: 844, isCoarsePointer: true, hasNoHover: false }, 768),
    false,
  );
});

test('wide width + no hover but a FINE pointer is desktop (e.g. a precise stylus-only oddity, not a phone)', () => {
  assert.equal(
    computeIsMobile({ width: 844, isCoarsePointer: false, hasNoHover: true }, 768),
    false,
  );
});

test('a short but wide desktop window (e.g. 1400x600) is never misclassified as mobile', () => {
  // This is the regression the "shorter viewport dimension" alternative would
  // have caused: a real mouse-driven desktop with a shallow window has no
  // touch/hover signal at all, so only the width check applies, and 1400 is
  // comfortably past the breakpoint.
  assert.equal(
    computeIsMobile({ width: 1400, isCoarsePointer: false, hasNoHover: false }, 768),
    false,
  );
});

test('exactly at the breakpoint is not mobile on width alone (matches the pre-existing < comparison)', () => {
  assert.equal(
    computeIsMobile({ width: 768, isCoarsePointer: false, hasNoHover: false }, 768),
    false,
  );
});

test('a custom mobileBreakpoint is honoured for the width branch', () => {
  assert.equal(
    computeIsMobile({ width: 500, isCoarsePointer: false, hasNoHover: false }, 400),
    false,
  );
  assert.equal(
    computeIsMobile({ width: 300, isCoarsePointer: false, hasNoHover: false }, 400),
    true,
  );
});
