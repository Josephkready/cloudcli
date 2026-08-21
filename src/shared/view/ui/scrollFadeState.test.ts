import assert from 'node:assert/strict';
import test from 'node:test';

import { computeScrollFade } from './scrollFadeState';

test('no fades when the content fits the viewport', () => {
  assert.deepEqual(computeScrollFade({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }), {
    canScrollLeft: false,
    canScrollRight: false,
  });
});

test('only a right fade at the start of an overflowing row', () => {
  // The #360 measurement: settings tabs row scrollWidth 780, clientWidth 364.
  assert.deepEqual(computeScrollFade({ scrollLeft: 0, scrollWidth: 780, clientWidth: 364 }), {
    canScrollLeft: false,
    canScrollRight: true,
  });
});

test('both fades when scrolled into the middle', () => {
  assert.deepEqual(computeScrollFade({ scrollLeft: 100, scrollWidth: 780, clientWidth: 364 }), {
    canScrollLeft: true,
    canScrollRight: true,
  });
});

test('only a left fade once scrolled to the end', () => {
  // scrollLeft 416 is where the #360 row lands after scrollLeft = 9999 is clamped.
  assert.deepEqual(computeScrollFade({ scrollLeft: 416, scrollWidth: 780, clientWidth: 364 }), {
    canScrollLeft: true,
    canScrollRight: false,
  });
});

test('sub-2px offsets read as no-scroll so the fade does not flicker at rest', () => {
  assert.deepEqual(computeScrollFade({ scrollLeft: 1, scrollWidth: 366, clientWidth: 364 }), {
    canScrollLeft: false,
    canScrollRight: false,
  });
});
