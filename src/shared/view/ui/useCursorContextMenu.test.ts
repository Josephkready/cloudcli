import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateViewportSafePosition, isActivatableMenuTarget } from './useCursorContextMenu';

// Pure-helper coverage for the shared cursor-context-menu chrome. The stateful
// hook wiring (effects, focus, listeners) needs a DOM harness (#103) and isn't
// exercised here; these lock in the geometry and the scoped keyboard-activation
// predicate — the latter being the file-tree vs session-menu divergence #161 unifies.

function withWindow(innerWidth: number, innerHeight: number, run: () => void) {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { innerWidth, innerHeight };
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = previous;
    }
  }
}

test('calculateViewportSafePosition: returns the cursor position when the menu fits', () => {
  withWindow(1000, 800, () => {
    assert.deepEqual(calculateViewportSafePosition(50, 60), { x: 50, y: 60 });
  });
});

test('calculateViewportSafePosition: flips left when the menu would overflow the right edge', () => {
  withWindow(1000, 800, () => {
    // 900 + 220 (default width) > 1000 -> 1000 - 220 - 10
    assert.equal(calculateViewportSafePosition(900, 60).x, 770);
  });
});

test('calculateViewportSafePosition: flips up when the menu would overflow the bottom edge', () => {
  withWindow(1000, 800, () => {
    // 700 + 300 (default height) > 800 -> 800 - 300 - 10
    assert.equal(calculateViewportSafePosition(50, 700).y, 490);
  });
});

test('calculateViewportSafePosition: clamps to the padding gutter near the top-left', () => {
  withWindow(1000, 800, () => {
    assert.deepEqual(calculateViewportSafePosition(2, 3), { x: 10, y: 10 });
  });
});

test('calculateViewportSafePosition: honors a custom menu width for the flip threshold', () => {
  withWindow(1000, 800, () => {
    // Same cursor, different widths -> different flipped x. The file-tree menu
    // passes 200; the default (session) menu is 220.
    assert.equal(calculateViewportSafePosition(850, 10, 200).x, 790); // 1000 - 200 - 10
    assert.equal(calculateViewportSafePosition(850, 10, 220).x, 770); // 1000 - 220 - 10
    // 850 + 200 = 1050 > 1000 and 850 + 220 = 1070 > 1000, so both flip.
  });
});

const menuitem = (): Element => ({ getAttribute: (n: string) => (n === 'role' ? 'menuitem' : null) } as unknown as Element);
const roleButton = (): Element => ({ getAttribute: (n: string) => (n === 'role' ? 'button' : null) } as unknown as Element);
const menuContaining = (...members: Element[]): Element =>
  ({ contains: (el: Element | null) => members.includes(el as Element) } as unknown as Element);

test('isActivatableMenuTarget: true for a menuitem inside the open menu', () => {
  const item = menuitem();
  assert.equal(isActivatableMenuTarget(item, menuContaining(item)), true);
});

test('isActivatableMenuTarget: false for a non-menuitem role even inside the menu (tightened scope)', () => {
  const item = roleButton();
  assert.equal(isActivatableMenuTarget(item, menuContaining(item)), false);
});

test('isActivatableMenuTarget: false for a menuitem outside the menu', () => {
  const outsider = menuitem();
  assert.equal(isActivatableMenuTarget(outsider, menuContaining(/* empty */)), false);
});

test('isActivatableMenuTarget: false when there is no focused element', () => {
  assert.equal(isActivatableMenuTarget(null, menuContaining()), false);
});

test('isActivatableMenuTarget: false when the menu element is missing', () => {
  assert.equal(isActivatableMenuTarget(menuitem(), null), false);
});
