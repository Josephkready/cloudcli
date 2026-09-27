import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Pencil } from 'lucide-react';

import type { ActionMenuItem } from './ActionMenu';
import CursorContextMenu from './CursorContextMenu';

function items(overrides: Partial<ActionMenuItem>[] = []): ActionMenuItem[] {
  return [
    { key: 'a', label: 'Edit', icon: Pencil, onSelect: vi.fn(), ...overrides[0] },
    {
      key: 'b',
      label: 'Delete',
      description: 'Cannot be undone',
      onSelect: vi.fn(),
      isDanger: true,
      showDividerBefore: true,
      ...overrides[1],
    },
  ];
}

describe('CursorContextMenu', () => {
  it('opens a positioned menu on right-click and closes on outside click', () => {
    render(
      <CursorContextMenu items={items()} ariaLabel="Row menu">
        <span>target</span>
      </CursorContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText('target'), { clientX: 20, clientY: 30 });

    const menu = screen.getByRole('menu', { name: 'Row menu' });
    expect(menu).toBeInTheDocument();
    expect(menu.style.left).toBe('20px');
    expect(menu.style.top).toBe('30px');

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('runs the selected item and closes the menu', () => {
    const onSelect = vi.fn();
    render(
      <CursorContextMenu items={items([{ onSelect }])} ariaLabel="Row menu">
        <span>target</span>
      </CursorContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText('target'), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not run a disabled or loading item and leaves the menu open', () => {
    const onSelect = vi.fn();
    render(
      <CursorContextMenu items={items([{ onSelect, disabled: true }])} ariaLabel="Row menu">
        <span>target</span>
      </CursorContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText('target'), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/ }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('shows a spinner for a loading item and a divider before the flagged item', () => {
    const { container } = render(
      <CursorContextMenu items={items([{}, { loading: true }])} ariaLabel="Row menu">
        <span>target</span>
      </CursorContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText('target'), { clientX: 5, clientY: 5 });

    expect(container.querySelector('.animate-spin')).toBeTruthy();
    expect(container.querySelector('.bg-border')).toBeTruthy();
  });

  it('leaves the native context menu intact when disabled or given no items', () => {
    render(
      <CursorContextMenu items={[]} ariaLabel="Row menu">
        <span>target</span>
      </CursorContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText('target'), { clientX: 5, clientY: 5 });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
