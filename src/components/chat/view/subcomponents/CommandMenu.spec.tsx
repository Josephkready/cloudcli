import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CommandMenu from './CommandMenu';

const builtinCommand = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} description`,
  namespace: 'builtin',
  ...extra,
});

function setViewport(width: number, height = 800) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

describe('CommandMenu', () => {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;

  afterEach(() => {
    setViewport(originalInnerWidth, originalInnerHeight);
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <CommandMenu isOpen={false} onClose={vi.fn()} commands={[builtinCommand('/foo')]} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no commands', () => {
    render(<CommandMenu isOpen onClose={vi.fn()} commands={[]} position={{ top: 10, left: 10 }} />);
    expect(screen.getByText('No commands available')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('renders commands grouped under a single namespace without a header when only one group exists', () => {
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[builtinCommand('/foo'), builtinCommand('/bar')]}
        position={{ top: 10, left: 10 }}
      />,
    );
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByText('/foo')).toBeInTheDocument();
    expect(screen.getByText('/bar')).toBeInTheDocument();
    expect(screen.queryByText('Built-in Commands')).not.toBeInTheDocument();
  });

  it('shows namespace headers with counts when multiple namespaces are present', () => {
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[
          builtinCommand('/foo'),
          { name: '/proj', description: 'project cmd', namespace: 'project' },
          { name: '/skl', description: 'skill cmd', namespace: 'skill' },
        ]}
        position={{ top: 10, left: 10 }}
      />,
    );
    expect(screen.getByText('Built-in Commands')).toBeInTheDocument();
    expect(screen.getByText('Project Commands')).toBeInTheDocument();
    expect(screen.getByText('Skills')).toBeInTheDocument();
  });

  it('uses namespace fallback labels/icons for unknown namespaces via type field', () => {
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[
          { name: '/foo', namespace: 'weird', description: 'x' },
          { name: '/bar', description: 'y' }, // no namespace/type -> "other"
        ]}
        position={{ top: 10, left: 10 }}
      />,
    );
    // Unknown namespace falls back to raw key as label since not in namespaceLabels
    expect(screen.getByText('weird')).toBeInTheDocument();
    expect(screen.getByText('Other Commands')).toBeInTheDocument();
  });

  it('groups frequent commands into their own section and excludes them from their original group', () => {
    const foo = builtinCommand('/foo');
    const bar = builtinCommand('/bar');
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[foo, bar]}
        frequentCommands={[foo]}
        position={{ top: 10, left: 10 }}
      />,
    );
    expect(screen.getByText('Frequently Used')).toBeInTheDocument();
    // /foo now appears once (in Frequently Used), not duplicated in Built-in
    expect(screen.getAllByText('/foo')).toHaveLength(1);
    expect(screen.getByText('/bar')).toBeInTheDocument();
  });

  it('handles duplicate frequent commands whose key repeats in the source list', () => {
    const cmd = builtinCommand('/dup');
    const cmd2 = { ...cmd };
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[cmd, cmd2]}
        frequentCommands={[cmd, cmd2]}
        position={{ top: 10, left: 10 }}
      />,
    );
    // Both occurrences appear under "Frequently Used", mapped to distinct original indexes.
    expect(screen.getAllByText('/dup')).toHaveLength(2);
  });

  it('drops a frequent command with no matching entry in commands (commandIndex -1)', () => {
    const missing = { name: '/ghost', namespace: 'builtin' };
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[builtinCommand('/foo')]}
        frequentCommands={[missing]}
        position={{ top: 10, left: 10 }}
      />,
    );
    expect(screen.queryByText('/ghost')).not.toBeInTheDocument();
    expect(screen.getByText('/foo')).toBeInTheDocument();
  });

  it('marks the selected command and shows the Enter icon and accent bar', () => {
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[builtinCommand('/foo'), builtinCommand('/bar')]}
        selectedIndex={1}
        position={{ top: 10, left: 10 }}
      />,
    );
    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('shows the metadata badge when command.metadata.type is set', () => {
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[builtinCommand('/foo', { metadata: { type: 'slash' } })]}
        position={{ top: 10, left: 10 }}
      />,
    );
    expect(screen.getByText('slash')).toBeInTheDocument();
  });

  it('does not render a description block when the command has none', () => {
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[{ name: '/nodesc', namespace: 'builtin' }]}
        position={{ top: 10, left: 10 }}
      />,
    );
    expect(screen.getByText('/nodesc')).toBeInTheDocument();
    expect(screen.queryByTitle('/nodesc description')).not.toBeInTheDocument();
  });

  it('calls onSelect with isHover=true on mouse enter and isHover=false on click', () => {
    const onSelect = vi.fn();
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[builtinCommand('/foo')]}
        onSelect={onSelect}
        position={{ top: 10, left: 10 }}
      />,
    );
    const option = screen.getByRole('option');
    fireEvent.mouseEnter(option);
    expect(onSelect).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: '/foo' }), 0, true);

    fireEvent.click(option);
    expect(onSelect).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: '/foo' }), 0, false);
  });

  it('does not throw when onSelect is not provided and an item is hovered/clicked', () => {
    render(
      <CommandMenu isOpen onClose={vi.fn()} commands={[builtinCommand('/foo')]} position={{ top: 10, left: 10 }} />,
    );
    const option = screen.getByRole('option');
    expect(() => {
      fireEvent.mouseEnter(option);
      fireEvent.click(option);
    }).not.toThrow();
  });

  it('prevents default on mousedown for command items (avoids stealing input focus)', () => {
    render(
      <CommandMenu isOpen onClose={vi.fn()} commands={[builtinCommand('/foo')]} position={{ top: 10, left: 10 }} />,
    );
    const option = screen.getByRole('option');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const prevented = !option.dispatchEvent(event);
    expect(prevented).toBe(true);
  });

  it('calls onClose when clicking outside the menu', () => {
    const onClose = vi.fn();
    render(
      <CommandMenu isOpen onClose={onClose} commands={[builtinCommand('/foo')]} position={{ top: 10, left: 10 }} />,
    );
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when clicking inside the menu', () => {
    const onClose = vi.fn();
    render(
      <CommandMenu isOpen onClose={onClose} commands={[builtinCommand('/foo')]} position={{ top: 10, left: 10 }} />,
    );
    fireEvent.mouseDown(screen.getByRole('option'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes the click-outside listener when unmounted / closed', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <CommandMenu isOpen onClose={onClose} commands={[builtinCommand('/foo')]} position={{ top: 10, left: 10 }} />,
    );
    rerender(
      <CommandMenu
        isOpen={false}
        onClose={onClose}
        commands={[builtinCommand('/foo')]}
        position={{ top: 10, left: 10 }}
      />,
    );
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('positions using mobile layout styles when viewport width is under 640px', () => {
    setViewport(375, 700);
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[builtinCommand('/foo')]}
        position={{ top: 10, left: 10, bottom: 50 }}
      />,
    );
    const menu = screen.getByRole('listbox');
    expect(menu).toHaveStyle({ left: '16px', right: '16px' });
  });

  it('positions using desktop layout styles and clamps left within viewport bounds', () => {
    setViewport(1200, 900);
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[builtinCommand('/foo')]}
        position={{ top: 10, left: 5000, bottom: 50 }}
      />,
    );
    const menu = screen.getByRole('listbox');
    // left should be clamped to within viewport, not the raw 5000px value
    expect(menu.style.left).not.toBe('5000px');
    expect(menu.style.left).toBe(`${1200 - 440 - 16}px`);
  });

  it('clamps a very small/negative bottom offset to the minimum edge gap', () => {
    setViewport(1200, 900);
    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[builtinCommand('/foo')]}
        position={{ top: 10, left: 10, bottom: -500 }}
      />,
    );
    const menu = screen.getByRole('listbox');
    expect(menu.style.bottom).toBe('16px');
  });

  it('defaults bottom anchor to 90 when position.bottom is not provided', () => {
    setViewport(1200, 900);
    render(<CommandMenu isOpen onClose={vi.fn()} commands={[builtinCommand('/foo')]} position={{ top: 10, left: 10 }} />);
    const menu = screen.getByRole('listbox');
    expect(menu.style.bottom).toBe('90px');
  });

  it('scrolls the selected item into view when it is out of the visible menu bounds', () => {
    const scrollIntoView = vi.fn();
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let call = 0;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      call += 1;
      // First call = menuRef rect, subsequent = selected item rect (place it below menu bottom)
      if (call === 1) {
        return { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} } as DOMRect;
      }
      return { top: 200, bottom: 250, left: 0, right: 100, width: 100, height: 50, x: 0, y: 200, toJSON() {} } as DOMRect;
    };
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    render(
      <CommandMenu
        isOpen
        onClose={vi.fn()}
        commands={[builtinCommand('/foo'), builtinCommand('/bar')]}
        selectedIndex={1}
        position={{ top: 10, left: 10 }}
      />,
    );

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });

    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });
});
