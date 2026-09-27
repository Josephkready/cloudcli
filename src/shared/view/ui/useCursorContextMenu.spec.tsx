import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useCursorContextMenu } from './useCursorContextMenu';

type Hook = ReturnType<typeof useCursorContextMenu>;

let hook: Hook;

function Harness({ disabled = false, menuWidth }: { disabled?: boolean; menuWidth?: number }) {
  hook = useCursorContextMenu({ disabled, menuWidth });
  return (
    <div onContextMenu={hook.openContextMenuAtCursor} data-testid="target">
      trigger
      {hook.isMenuOpen && (
        <div ref={hook.menuRef} data-testid="menu">
          <button type="button" role="menuitem">A</button>
          <button type="button" role="menuitem">B</button>
          <button type="button" role="menuitem" disabled>C</button>
        </div>
      )}
    </div>
  );
}

describe('useCursorContextMenu', () => {
  it('opens the menu at a viewport-safe position on right-click', () => {
    render(<Harness />);
    fireEvent.contextMenu(document.querySelector('[data-testid="target"]')!, { clientX: 50, clientY: 60 });

    expect(hook.isMenuOpen).toBe(true);
    expect(hook.menuPosition).toEqual({ x: 50, y: 60 });
  });

  it('ignores right-click while disabled', () => {
    render(<Harness disabled />);
    fireEvent.contextMenu(document.querySelector('[data-testid="target"]')!, { clientX: 50, clientY: 60 });
    expect(hook.isMenuOpen).toBe(false);
  });

  it('closes on outside mousedown but stays open for a mousedown inside the menu', () => {
    render(
      <div>
        <Harness />
        <button type="button">outside</button>
      </div>,
    );
    fireEvent.contextMenu(document.querySelector('[data-testid="target"]')!, { clientX: 10, clientY: 10 });
    expect(hook.isMenuOpen).toBe(true);

    fireEvent.mouseDown(document.querySelector('[data-testid="menu"]')!);
    expect(hook.isMenuOpen).toBe(true);

    fireEvent.mouseDown(screen.getByText('outside'));
    expect(hook.isMenuOpen).toBe(false);
  });

  it('closes on Escape', () => {
    render(<Harness />);
    fireEvent.contextMenu(document.querySelector('[data-testid="target"]')!, { clientX: 10, clientY: 10 });
    expect(hook.isMenuOpen).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(hook.isMenuOpen).toBe(false);
  });

  it('closeContextMenu closes the menu directly', () => {
    render(<Harness />);
    fireEvent.contextMenu(document.querySelector('[data-testid="target"]')!, { clientX: 10, clientY: 10 });
    act(() => hook.closeContextMenu());
    expect(hook.isMenuOpen).toBe(false);
  });

  it('ArrowDown/ArrowUp move focus between enabled menu items and wrap around', () => {
    render(<Harness />);
    fireEvent.contextMenu(document.querySelector('[data-testid="target"]')!, { clientX: 10, clientY: 10 });

    const [a, b] = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLButtonElement[];

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(a);

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(b);

    // Wraps from the last enabled item back to the first (disabled "C" excluded
    // by the :not([disabled]) selector).
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(a);

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(b);
  });

  it('does nothing on arrow keys when there are no enabled menu items', () => {
    function EmptyHarness() {
      hook = useCursorContextMenu();
      return (
        <div onContextMenu={hook.openContextMenuAtCursor} data-testid="target">
          {hook.isMenuOpen && <div ref={hook.menuRef} data-testid="menu" />}
        </div>
      );
    }
    render(<EmptyHarness />);
    fireEvent.contextMenu(document.querySelector('[data-testid="target"]')!, { clientX: 10, clientY: 10 });

    expect(() => fireEvent.keyDown(document, { key: 'ArrowDown' })).not.toThrow();
  });

  it('Enter/Space activates the focused menuitem via a real click, scoped to menu items only', () => {
    render(<Harness />);
    fireEvent.contextMenu(document.querySelector('[data-testid="target"]')!, { clientX: 10, clientY: 10 });

    const [a] = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLButtonElement[];
    const clickSpy = vi.fn();
    a.addEventListener('click', clickSpy);
    a.focus();

    fireEvent.keyDown(document, { key: 'Enter' });
    expect(clickSpy).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: ' ' });
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it('Enter does nothing when focus is outside the menu', () => {
    render(
      <div>
        <Harness />
        <button type="button" id="outsideBtn">outside</button>
      </div>,
    );
    fireEvent.contextMenu(document.querySelector('[data-testid="target"]')!, { clientX: 10, clientY: 10 });

    const outsideButton = document.getElementById('outsideBtn') as HTMLButtonElement;
    const clickSpy = vi.fn();
    outsideButton.addEventListener('click', clickSpy);
    outsideButton.focus();

    fireEvent.keyDown(document, { key: 'Enter' });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('honors a custom menu width for the flip threshold', () => {
    render(<Harness menuWidth={50} />);
    fireEvent.contextMenu(document.querySelector('[data-testid="target"]')!, { clientX: 10, clientY: 10 });
    expect(hook.menuPosition.x).toBe(10);
  });
});
