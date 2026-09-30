import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { BashCommandDisplay } from './BashCommandDisplay';

afterEach(() => {
  cleanup();
});

describe('BashCommandDisplay', () => {
  it('renders the command with no expandable header when there is no output', () => {
    const { container } = render(<BashCommandDisplay command="ls -la" />);
    expect(screen.getByText('ls -la')).toBeTruthy();
    expect(container.querySelector('[role="button"]')).toBeNull();
  });

  it('toggles open/closed on click when there is output, revealing the output body', () => {
    const { container } = render(<BashCommandDisplay command="echo hi" output="hi" />);
    const header = container.querySelector('[role="button"]') as HTMLElement;
    expect(screen.queryByText('hi')).toBeNull();

    fireEvent.click(header);
    expect(screen.getByText('hi')).toBeTruthy();

    fireEvent.click(header);
    expect(screen.queryByText('hi')).toBeNull();
  });

  it('toggles via Enter and Space keys', () => {
    const { container } = render(<BashCommandDisplay command="echo hi" output="hi" />);
    const header = container.querySelector('[role="button"]') as HTMLElement;

    fireEvent.keyDown(header, { key: 'Enter' });
    expect(screen.getByText('hi')).toBeTruthy();

    fireEvent.keyDown(header, { key: ' ' });
    expect(screen.queryByText('hi')).toBeNull();

    // Other keys are ignored.
    fireEvent.keyDown(header, { key: 'a' });
    expect(screen.queryByText('hi')).toBeNull();
  });

  it('auto-opens once output arrives when isError is true', () => {
    const { container, rerender } = render(<BashCommandDisplay command="false" />);
    expect(container.querySelector('[role="button"]')).toBeNull();

    rerender(<BashCommandDisplay command="false" output="boom" isError />);
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('auto-opens once output arrives when defaultOpen is true', () => {
    const { rerender } = render(<BashCommandDisplay command="build" defaultOpen />);
    rerender(<BashCommandDisplay command="build" output="built ok" defaultOpen />);
    expect(screen.getByText('built ok')).toBeTruthy();
  });

  it('shows the description when collapsed, and inline above output when expanded', () => {
    const { container } = render(<BashCommandDisplay command="ls" output="a\nb" description="lists the dir" />);
    expect(screen.getByText('lists the dir')).toBeTruthy();

    fireEvent.click(container.querySelector('[role="button"]') as HTMLElement);
    expect(screen.getByText('lists the dir')).toBeTruthy();
  });

  it('shows a running spinner while status is running', () => {
    const { container } = render(<BashCommandDisplay command="sleep 5" status="running" />);
    expect(container.querySelector('.animate-spin')).toBeTruthy();
  });

  it('shows a status badge for non-running statuses', () => {
    render(<BashCommandDisplay command="ls" status="completed" />);
    expect(screen.getByText('Completed')).toBeTruthy();
  });

  it('shows the output line count when collapsed with output', () => {
    render(<BashCommandDisplay command="ls" output={'a\nb\nc'} />);
    expect(screen.getByText('3 lines')).toBeTruthy();
  });

  it('shows singular "line" for single-line output', () => {
    render(<BashCommandDisplay command="ls" output="only one line" />);
    expect(screen.getByText('1 line')).toBeTruthy();
  });

  it('copies the command to the clipboard and shows a checkmark that reverts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: async () => '' },
    });

    render(<BashCommandDisplay command="echo copy-me" />);
    const copyButton = screen.getByRole('button', { name: /copy command/i });

    await act(async () => {
      fireEvent.click(copyButton);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('echo copy-me');

    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    vi.useRealTimers();
  });

  it('copy button click does not toggle the expand/collapse state (stopPropagation)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: async () => '' },
    });

    render(<BashCommandDisplay command="echo hi" output="hi there" />);
    const copyButton = screen.getByRole('button', { name: /copy command/i });

    await act(async () => {
      fireEvent.click(copyButton);
      await Promise.resolve();
    });
    // Still collapsed — the copy click must not have toggled the row open.
    expect(screen.queryByText('hi there')).toBeNull();
  });

  // Touch devices have no `:hover`, so a hover-only reveal
  // (`opacity-0 group-hover/cmd:opacity-100`) left this button invisible yet
  // still tappable on iPad/phones. `touch:opacity-100` is the repo's existing
  // coarse/no-hover escape hatch (src/index.css) and must stay alongside the
  // hover classes so desktop hover-reveal is unchanged.
  it('keeps the copy button visible on touch/no-hover pointers, not just on hover', () => {
    render(<BashCommandDisplay command="echo hi" />);
    const copyButton = screen.getByRole('button', { name: /copy command/i });

    expect(copyButton).toHaveClass('touch:opacity-100', 'opacity-0', 'group-hover/cmd:opacity-100');
  });
});
