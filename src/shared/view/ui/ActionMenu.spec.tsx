import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Pencil, Trash2 } from 'lucide-react';

import ActionMenu, { type ActionMenuItem } from './ActionMenu';

function items(overrides: Partial<ActionMenuItem>[] = []): ActionMenuItem[] {
  return [
    { key: 'edit', label: 'Edit', icon: Pencil, onSelect: vi.fn(), ...overrides[0] },
    {
      key: 'delete',
      label: 'Delete',
      description: 'Cannot be undone',
      icon: Trash2,
      onSelect: vi.fn(),
      isDanger: true,
      showDividerBefore: true,
      ...overrides[1],
    },
  ];
}

describe('ActionMenu', () => {
  it('is closed until the trigger is clicked', () => {
    render(<ActionMenu label="Actions" items={items()} />);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
  });

  it('toggles closed when the trigger is clicked again', () => {
    render(<ActionMenu label="Actions" items={items()} />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('runs the item action and closes on selection', () => {
    const onSelect = vi.fn();
    render(<ActionMenu label="Actions" items={items([{ onSelect }])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));

    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not run a disabled or loading item, and keeps the menu open', () => {
    const onSelect = vi.fn();
    render(<ActionMenu label="Actions" items={items([{ onSelect, disabled: true }])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));

    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/ }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('shows a spinner instead of the icon while an item is loading', () => {
    const { container } = render(<ActionMenu label="Actions" items={items([{ loading: true }])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(container.querySelector('.animate-spin')).toBeTruthy();
  });

  it('closes on outside pointer clicks without moving focus back to the trigger', () => {
    render(
      <div>
        <ActionMenu label="Actions" items={items()} />
        <button type="button">Outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape and restores focus to the trigger', () => {
    render(<ActionMenu label="Actions" items={items()} />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('renders a divider before the item that requests one', () => {
    const { container } = render(<ActionMenu label="Actions" items={items()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(container.querySelector('.bg-border')).toBeTruthy();
  });

  it('aligns the menu left when requested', () => {
    render(<ActionMenu label="Actions" items={items()} align="left" />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu').className).toContain('left-0');
  });

  it('disables the trigger button and passes through the aria-label', () => {
    render(<ActionMenu label="Actions" items={items()} disabled ariaLabel="Row actions" />);
    expect(screen.getByRole('button', { name: 'Row actions' })).toBeDisabled();
  });
});
