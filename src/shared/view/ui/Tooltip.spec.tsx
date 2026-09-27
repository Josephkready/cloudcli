import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Tooltip from './Tooltip';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('Tooltip', () => {
  it('renders only its children when there is no content to show', () => {
    render(<Tooltip>trigger</Tooltip>);
    expect(screen.getByText('trigger')).toBeInTheDocument();
    expect(screen.queryByText('tip')).toBeNull();
  });

  it('shows the tooltip after the hover delay, and hides it on mouse leave', () => {
    render(<Tooltip content="tip">trigger</Tooltip>);
    const trigger = screen.getByText('trigger') as HTMLElement;

    fireEvent.mouseEnter(trigger);
    expect(screen.queryByText('tip')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByText('tip')).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByText('tip')).toBeNull();
  });

  it('honors a custom delay', () => {
    render(<Tooltip content="tip" delay={1000}>trigger</Tooltip>);
    const trigger = screen.getByText('trigger') as HTMLElement;
    fireEvent.mouseEnter(trigger);

    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByText('tip')).toBeNull();

    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByText('tip')).toBeInTheDocument();
  });

  it('re-entering before the delay elapses resets the timer', () => {
    render(<Tooltip content="tip">trigger</Tooltip>);
    const trigger = screen.getByText('trigger') as HTMLElement;

    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(200));
    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText('tip')).toBeNull();

    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByText('tip')).toBeInTheDocument();
  });

  it('shows the tooltip on a long touch press and swallows the trailing touchend', () => {
    render(<Tooltip content="tip">trigger</Tooltip>);
    const trigger = screen.getByText('trigger') as HTMLElement;

    fireEvent.touchStart(trigger);
    act(() => vi.advanceTimersByTime(350));
    expect(screen.getByText('tip')).toBeInTheDocument();

    // A long-press-triggered tooltip should not be dismissed by its own touchend.
    fireEvent.touchEnd(trigger);
    expect(screen.getByText('tip')).toBeInTheDocument();
  });

  it('a short tap (before the delay) never shows the tooltip', () => {
    render(<Tooltip content="tip">trigger</Tooltip>);
    const trigger = screen.getByText('trigger') as HTMLElement;

    fireEvent.touchStart(trigger);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.touchEnd(trigger);
    act(() => vi.advanceTimersByTime(350));

    expect(screen.queryByText('tip')).toBeNull();
  });

  it('touchcancel also dismisses the tooltip', () => {
    render(<Tooltip content="tip">trigger</Tooltip>);
    const trigger = screen.getByText('trigger') as HTMLElement;

    fireEvent.touchStart(trigger);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.touchCancel(trigger);

    expect(screen.queryByText('tip')).toBeNull();
  });

  it('dismisses on an outside pointerdown but stays open for a pointerdown inside', () => {
    render(
      <div>
        <Tooltip content="tip">trigger</Tooltip>
        <button type="button">outside</button>
      </div>,
    );
    const trigger = screen.getByText('trigger') as HTMLElement;
    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(350));
    expect(screen.getByText('tip')).toBeInTheDocument();

    fireEvent.pointerDown(trigger);
    expect(screen.getByText('tip')).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByText('tip')).toBeNull();
  });

  it('positions the tooltip for each side and renders the matching arrow', () => {
    (['top', 'bottom', 'left', 'right'] as const).forEach((position) => {
      const { unmount } = render(<Tooltip content="tip" position={position}>trigger</Tooltip>);
      const trigger = screen.getByText('trigger') as HTMLElement;
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20, x: 10, y: 10, toJSON: () => ({}),
      });

      fireEvent.mouseEnter(trigger);
      act(() => vi.advanceTimersByTime(350));
      act(() => vi.runOnlyPendingTimers());

      expect(screen.getByText('tip')).toBeInTheDocument();
      unmount();
    });
  });

  it('cleans up its timer on unmount without throwing', () => {
    const { unmount } = render(<Tooltip content="tip">trigger</Tooltip>);
    const trigger = screen.getByText('trigger') as HTMLElement;
    fireEvent.mouseEnter(trigger);
    expect(() => unmount()).not.toThrow();
  });

  it('applies a custom className to the tooltip bubble', () => {
    render(<Tooltip content="tip" className="my-tip">trigger</Tooltip>);
    const trigger = screen.getByText('trigger') as HTMLElement;
    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(350));
    expect(screen.getByText('tip').className).toContain('my-tip');
  });
});
