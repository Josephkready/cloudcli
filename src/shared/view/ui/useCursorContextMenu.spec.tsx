import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useCursorContextMenu } from './useCursorContextMenu';

// Companion to the pure-helper coverage in useCursorContextMenu.test.ts (node:test).
// Everything here needs a live DOM: `renderHook`/`act` for the open/close state and
// real document-level `mousedown`/`keydown` listeners for dismissal and roving focus.

function contextMenuEvent(clientX: number, clientY: number) {
  return {
    clientX,
    clientY,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as ReactMouseEvent<HTMLDivElement>;
}

/**
 * Like `contextMenuEvent` but with spied `preventDefault`/`stopPropagation`, so a
 * test can assert whether the hook suppressed the native browser menu. Returned as
 * a plain object (mocks stay typed); cast to the React event at the call site.
 */
function spyContextMenuEvent(clientX: number, clientY: number) {
  return {
    clientX,
    clientY,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

/** Minimal consumer that wires `menuRef` to real markup, like CursorContextMenu does. */
function MenuHarness({ disabled = false, empty = false }: { disabled?: boolean; empty?: boolean }) {
  const { isMenuOpen, menuPosition, menuRef, openContextMenuAtCursor } = useCursorContextMenu({
    disabled,
  });

  return (
    <div>
      <div data-testid="trigger" onContextMenu={openContextMenuAtCursor}>
        right click me
      </div>
      <div data-testid="outside">elsewhere</div>
      {isMenuOpen && (
        <div ref={menuRef} role="menu" aria-label="Test menu" data-position={`${menuPosition.x},${menuPosition.y}`}>
          {empty ? (
            // An open menu with no menuitems - keyboard nav has nothing to rove to.
            <span data-testid="empty-note">No actions available</span>
          ) : (
            <>
              <button type="button" role="menuitem">
                First
              </button>
              <button type="button" role="menuitem">
                Second
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Consumer with an onClick-spied menuitem plus a DECOY: a focusable, role-bearing
 * element sitting inside the same open menu that is *not* a menuitem. Lets the
 * security tests prove the wired keydown listener activates only real menuitems -
 * never any focused element that merely carries a `role`. This is the exact
 * divergence #161 unified (old FileContextMenu's loose `hasAttribute('role')`).
 */
function ActivationHarness({
  onItemClick,
  onDecoyClick,
}: {
  onItemClick: () => void;
  onDecoyClick: () => void;
}) {
  const { isMenuOpen, menuRef, openContextMenuAtCursor } = useCursorContextMenu();

  return (
    <div>
      <div data-testid="trigger" onContextMenu={openContextMenuAtCursor}>
        right click me
      </div>
      {isMenuOpen && (
        <div ref={menuRef} role="menu" aria-label="Activation menu">
          <button type="button" role="menuitem" onClick={onItemClick}>
            Activate
          </button>
          {/* Focusable, role-bearing, and inside the menu - yet not a menuitem. */}
          <button type="button" role="option" data-testid="decoy" onClick={onDecoyClick}>
            Decoy
          </button>
        </div>
      )}
    </div>
  );
}

describe('useCursorContextMenu', () => {
  it('starts closed and opens at a viewport-safe cursor position', () => {
    const { result } = renderHook(() => useCursorContextMenu());

    expect(result.current.isMenuOpen).toBe(false);
    expect(result.current.menuPosition).toEqual({ x: 0, y: 0 });

    act(() => result.current.openContextMenuAtCursor(contextMenuEvent(120, 140)));

    expect(result.current.isMenuOpen).toBe(true);
    expect(result.current.menuPosition).toEqual({ x: 120, y: 140 });
  });

  it('ignores right-click while disabled', () => {
    const { result } = renderHook(() => useCursorContextMenu({ disabled: true }));

    act(() => result.current.openContextMenuAtCursor(contextMenuEvent(120, 140)));

    expect(result.current.isMenuOpen).toBe(false);
  });

  it('closes on a real Escape keydown', () => {
    const { result } = renderHook(() => useCursorContextMenu());

    act(() => result.current.openContextMenuAtCursor(contextMenuEvent(10, 10)));
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(result.current.isMenuOpen).toBe(false);
  });

  it('removes every document listener it added once the menu closes', () => {
    // Asserting "a second Escape does nothing" would be vacuous - closing an
    // already-closed menu is a no-op either way. Counting the listeners is what
    // actually pins the effect cleanup, so an open/close cycle can't leak one.
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const countOf = (spy: typeof addSpy, type: string) =>
      spy.mock.calls.filter(([eventType]) => eventType === type).length;

    const { result } = renderHook(() => useCursorContextMenu());
    expect(countOf(addSpy, 'keydown')).toBe(0);

    act(() => result.current.openContextMenuAtCursor(contextMenuEvent(10, 10)));

    // Two keydown listeners: dismissal (Escape) and roving-focus navigation.
    expect(countOf(addSpy, 'keydown')).toBe(2);
    expect(countOf(addSpy, 'mousedown')).toBe(1);
    expect(countOf(removeSpy, 'keydown')).toBe(0);

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(countOf(removeSpy, 'keydown')).toBe(2);
    expect(countOf(removeSpy, 'mousedown')).toBe(1);
  });

  it('closes on an outside mousedown but not on one inside the menu', () => {
    render(<MenuHarness />);

    fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 30, clientY: 40 });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'First' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('moves focus between menu items with the arrow keys and wraps around', () => {
    render(<MenuHarness />);

    fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 30, clientY: 40 });

    const first = screen.getByRole('menuitem', { name: 'First' });
    const second = screen.getByRole('menuitem', { name: 'Second' });

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(second);
  });

  it('treats arrow and Enter keys as no-ops when the open menu has no menuitems', () => {
    // Exercises the empty-menuitems early return in the roving handler: an open menu
    // with nothing to rove to must not throw or move focus on navigation keys.
    render(<MenuHarness empty />);

    fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 20, clientY: 20 });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    const before = document.activeElement;
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(document.activeElement).toBe(before);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('clamps the open position to stay inside the viewport near an edge', () => {
    // #203's open test uses a cursor that already fits, so it never exercises the
    // wired clamp. Open far past the bottom-right corner to force the flip.
    const { result } = renderHook(() => useCursorContextMenu());

    act(() =>
      result.current.openContextMenuAtCursor(
        contextMenuEvent(window.innerWidth + 500, window.innerHeight + 500),
      ),
    );

    expect(result.current.isMenuOpen).toBe(true);
    // Default menu box is 220x300 with a 10px gutter (calculateViewportSafePosition).
    expect(result.current.menuPosition).toEqual({
      x: window.innerWidth - 220 - 10,
      y: window.innerHeight - 300 - 10,
    });
  });

  it('repositions to the new cursor point when right-clicked again while open', () => {
    const { result } = renderHook(() => useCursorContextMenu());

    act(() => result.current.openContextMenuAtCursor(contextMenuEvent(30, 40)));
    expect(result.current.menuPosition).toEqual({ x: 30, y: 40 });

    act(() => result.current.openContextMenuAtCursor(contextMenuEvent(75, 95)));
    expect(result.current.isMenuOpen).toBe(true);
    expect(result.current.menuPosition).toEqual({ x: 75, y: 95 });
  });

  it('leaves the native browser menu intact while disabled (no preventDefault)', () => {
    const { result } = renderHook(() => useCursorContextMenu({ disabled: true }));
    const event = spyContextMenuEvent(120, 140);

    act(() => result.current.openContextMenuAtCursor(event as unknown as ReactMouseEvent<HTMLDivElement>));

    expect(result.current.isMenuOpen).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('suppresses the native browser menu while enabled (preventDefault + stopPropagation)', () => {
    const { result } = renderHook(() => useCursorContextMenu());
    const event = spyContextMenuEvent(120, 140);

    act(() => result.current.openContextMenuAtCursor(event as unknown as ReactMouseEvent<HTMLDivElement>));

    expect(result.current.isMenuOpen).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('focuses the last item when ArrowUp is the first key pressed (currentIndex === -1)', () => {
    // #203 covers the ArrowDown-from-nothing case (its first arrow lands on the
    // first item); the reverse first-press branch (wrap to the last item) is the gap.
    render(<MenuHarness />);

    fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 30, clientY: 40 });

    const second = screen.getByRole('menuitem', { name: 'Second' });
    expect(document.activeElement).not.toBe(second);

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(second);
  });

  it('activates the focused menuitem on Enter and on Space', () => {
    const onItemClick = vi.fn();
    render(<ActivationHarness onItemClick={onItemClick} onDecoyClick={vi.fn()} />);

    fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 10, clientY: 10 });

    const item = screen.getByRole('menuitem', { name: 'Activate' });

    item.focus();
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onItemClick).toHaveBeenCalledTimes(1);

    item.focus();
    fireEvent.keyDown(document, { key: ' ' });
    expect(onItemClick).toHaveBeenCalledTimes(2);
  });

  it('does not activate a focused non-menuitem that merely holds a role (scoped Enter/Space)', () => {
    // Security regression pin: the wired keydown listener must refuse to `.click()`
    // a focused role-bearing element that is not a menuitem. Reverting
    // `isActivatableMenuTarget` to the loose `hasAttribute('role')` check turns this red.
    const onDecoyClick = vi.fn();
    render(<ActivationHarness onItemClick={vi.fn()} onDecoyClick={onDecoyClick} />);

    fireEvent.contextMenu(screen.getByTestId('trigger'), { clientX: 10, clientY: 10 });

    const decoy = screen.getByTestId('decoy');
    decoy.focus();
    expect(document.activeElement).toBe(decoy);

    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: ' ' });

    expect(onDecoyClick).not.toHaveBeenCalled();
    // Enter/Space on a non-menuitem is inert, so the menu also stays open.
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
