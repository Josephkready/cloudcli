import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import EffortDropdown from './EffortDropdown';

afterEach(() => {
  cleanup();
});

function open() {
  fireEvent.click(screen.getByLabelText('Select reasoning effort'));
}

describe('EffortDropdown', () => {
  it('opens the menu and lists Default plus the provided options', () => {
    render(
      <EffortDropdown effort="default" availableEffortOptions={[{ value: 'low' }, { value: 'high' }]} onSelectEffort={vi.fn()} />,
    );

    open();

    const menu = screen.getByRole('menu');
    const labels = Array.from(menu.querySelectorAll('[role="menuitemradio"]')).map(
      (el) => el.textContent?.trim(),
    );
    expect(labels).toEqual(['Default', 'low', 'high']);
  });

  it('selects an option on click (mouse / keyboard path)', () => {
    const onSelectEffort = vi.fn();
    render(
      <EffortDropdown effort="default" availableEffortOptions={[{ value: 'low' }, { value: 'high' }]} onSelectEffort={onSelectEffort} />,
    );

    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'high' }));

    expect(onSelectEffort).toHaveBeenCalledWith('high');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  // Regression: on mobile the browser fires pointer events but synthesizes no
  // `click` on the portaled option, so a click-only handler never selects.
  // The option must also respond to a touch `pointerup`.
  it('selects an option on touch pointerup even when no click follows', () => {
    const onSelectEffort = vi.fn();
    render(
      <EffortDropdown effort="default" availableEffortOptions={[{ value: 'low' }, { value: 'high' }]} onSelectEffort={onSelectEffort} />,
    );

    open();
    const option = screen.getByRole('menuitemradio', { name: 'high' });
    fireEvent.pointerUp(option, { pointerType: 'touch' });

    expect(onSelectEffort).toHaveBeenCalledWith('high');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  // #499: changing reasoning effort mid-conversation can break prompt caching
  // and raise cost, so once a conversation has messages a different selection
  // must be confirmed before it applies (warn-and-allow).
  it('applies a change immediately before the conversation has started', () => {
    const onSelectEffort = vi.fn();
    render(
      <EffortDropdown
        effort="default"
        availableEffortOptions={[{ value: 'low' }, { value: 'high' }]}
        onSelectEffort={onSelectEffort}
        conversationStarted={false}
      />,
    );

    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'high' }));

    expect(onSelectEffort).toHaveBeenCalledWith('high');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('warns instead of applying when changing effort mid-conversation (#499)', () => {
    const onSelectEffort = vi.fn();
    render(
      <EffortDropdown
        effort="default"
        availableEffortOptions={[{ value: 'low' }, { value: 'high' }]}
        onSelectEffort={onSelectEffort}
        conversationStarted
      />,
    );

    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'high' }));

    // Not applied yet: a confirmation must be shown first.
    expect(onSelectEffort).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText(/caching/i)).toBeTruthy();
  });

  it('applies the change after the mid-conversation warning is confirmed (#499)', () => {
    const onSelectEffort = vi.fn();
    render(
      <EffortDropdown
        effort="default"
        availableEffortOptions={[{ value: 'low' }, { value: 'high' }]}
        onSelectEffort={onSelectEffort}
        conversationStarted
      />,
    );

    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'high' }));
    fireEvent.click(screen.getByRole('button', { name: /change to high/i }));

    expect(onSelectEffort).toHaveBeenCalledWith('high');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the current effort when the mid-conversation warning is dismissed (#499)', () => {
    const onSelectEffort = vi.fn();
    render(
      <EffortDropdown
        effort="default"
        availableEffortOptions={[{ value: 'low' }, { value: 'high' }]}
        onSelectEffort={onSelectEffort}
        conversationStarted
      />,
    );

    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'high' }));
    fireEvent.click(screen.getByRole('button', { name: /keep/i }));

    expect(onSelectEffort).not.toHaveBeenCalled();
  });

  it('does not warn when re-selecting the current effort mid-conversation (#499)', () => {
    const onSelectEffort = vi.fn();
    render(
      <EffortDropdown
        effort="high"
        availableEffortOptions={[{ value: 'low' }, { value: 'high' }]}
        onSelectEffort={onSelectEffort}
        conversationStarted
      />,
    );

    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'high' }));

    // Same value → no change, no warning, just closes.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ignores a mouse pointerup and selects only on the click that follows it', () => {
    const onSelectEffort = vi.fn();
    render(
      <EffortDropdown effort="default" availableEffortOptions={[{ value: 'low' }, { value: 'high' }]} onSelectEffort={onSelectEffort} />,
    );

    open();
    const option = screen.getByRole('menuitemradio', { name: 'high' });

    // A mouse pointerup must NOT select (mouse goes through onClick), so the
    // menu is still open and nothing has fired yet. This makes the
    // `pointerType !== 'mouse'` guard load-bearing: drop it and this fails.
    fireEvent.pointerUp(option, { pointerType: 'mouse' });
    expect(onSelectEffort).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();

    // The real mouse click is what selects — exactly once.
    fireEvent.click(option);
    expect(onSelectEffort).toHaveBeenCalledTimes(1);
    expect(onSelectEffort).toHaveBeenCalledWith('high');
  });
});
