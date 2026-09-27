import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import ActivityIndicator from './ActivityIndicator';
import type { SessionActivity } from '../../../../hooks/useSessionProtection';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function activity(overrides: Partial<SessionActivity> = {}): SessionActivity {
  return {
    statusText: null,
    canInterrupt: false,
    startedAt: Date.now(),
    blocked: false,
    ...overrides,
  };
}

describe('ActivityIndicator', () => {
  it('renders nothing when there is no activity', () => {
    const { container } = render(<ActivityIndicator activity={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the provided statusText verbatim (trailing dots stripped)', () => {
    render(<ActivityIndicator activity={activity({ statusText: 'Reading files...' })} />);
    expect(screen.getByText('Reading files…')).toBeTruthy();
  });

  it('falls back to a rotating default action word when statusText is null', () => {
    render(<ActivityIndicator activity={activity({ statusText: null })} />);
    // One of the default action words + ellipsis renders.
    expect(
      ['Thinking', 'Processing', 'Analyzing', 'Working', 'Computing', 'Reasoning'].some((word) =>
        screen.queryByText(`${word}…`),
      ),
    ).toBe(true);
  });

  it('shows elapsed seconds under a minute, and minutes+seconds past it', () => {
    vi.useFakeTimers();
    const start = Date.now();
    render(<ActivityIndicator activity={activity({ startedAt: start })} />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('5s')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(65000); // total 70s elapsed
    });
    expect(screen.getByText('1m 10s')).toBeTruthy();
  });

  it('shows the Stop button and calls onAbort when canInterrupt and onAbort are provided', () => {
    const onAbort = vi.fn();
    render(<ActivityIndicator activity={activity({ canInterrupt: true })} onAbort={onAbort} />);

    const stopButton = screen.getByRole('button', { name: 'Stop' });
    fireEvent.click(stopButton);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('does not show the Stop button when canInterrupt is false', () => {
    render(<ActivityIndicator activity={activity({ canInterrupt: false })} onAbort={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('does not show the Stop button when onAbort is not provided even if canInterrupt', () => {
    render(<ActivityIndicator activity={activity({ canInterrupt: true })} />);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('keeps rendering (exit animation) briefly after activity clears, then disappears', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<ActivityIndicator activity={activity()} />);
    expect(container.firstChild).not.toBeNull();

    rerender(<ActivityIndicator activity={null} />);
    // Still rendered mid-exit-animation.
    expect(container.firstChild).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(container.firstChild).toBeNull();
  });

  it('applies the focused tab styling when isInputFocused is true', () => {
    const { container } = render(<ActivityIndicator activity={activity()} isInputFocused />);
    expect(container.querySelector('.border-primary\\/30')).toBeTruthy();
  });
});
