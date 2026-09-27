import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Reasoning, ReasoningContent, ReasoningTrigger } from './Reasoning';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function Basic(props: React.ComponentProps<typeof Reasoning>) {
  return (
    <Reasoning {...props}>
      <ReasoningTrigger />
      <ReasoningContent>the reasoning text</ReasoningContent>
    </Reasoning>
  );
}

describe('Reasoning', () => {
  it('auto-opens while streaming and shows the shimmering "Thinking..." trigger', () => {
    render(<Basic isStreaming />);
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
    expect(screen.getByText('the reasoning text')).toBeInTheDocument();
  });

  it('auto-closes ~1s after streaming ends, reporting the elapsed duration', () => {
    vi.setSystemTime(0);
    function Wrapper() {
      const [isStreaming, setIsStreaming] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setIsStreaming(false)}>stop</button>
          <Basic isStreaming={isStreaming} />
        </div>
      );
    }
    render(<Wrapper />);
    expect(screen.getByText('the reasoning text')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(4000));
    fireEvent.click(screen.getByText('stop'));

    expect(screen.getByText('Thought for 4 seconds')).toBeInTheDocument();
    expect(screen.getByText('the reasoning text')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('the reasoning text').closest('[data-state]')?.getAttribute('data-state')).toBe('closed');
  });

  it('does not auto-close a manually reopened panel a second time', () => {
    function Wrapper() {
      const [isStreaming, setIsStreaming] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setIsStreaming(false)}>stop</button>
          <Basic isStreaming={isStreaming} />
        </div>
      );
    }
    render(<Wrapper />);
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.click(screen.getByText('stop'));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('the reasoning text').closest('[data-state]')?.getAttribute('data-state')).toBe('closed');

    // Manually reopen: hasAutoClosed is now true, so it must stay open.
    fireEvent.click(screen.getByRole('button', { name: /Thought for/ }));
    expect(screen.getByText('the reasoning text')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText('the reasoning text')).toBeInTheDocument();
  });

  it('defaultOpen=false suppresses the streaming auto-open', () => {
    render(<Basic isStreaming defaultOpen={false} />);
    expect(screen.getByText('the reasoning text').closest('[data-state]')?.getAttribute('data-state')).toBe('closed');
  });

  it('supports fully controlled open state via open/onOpenChange', () => {
    const onOpenChange = vi.fn();
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <Reasoning
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            onOpenChange(next);
          }}
        >
          <ReasoningTrigger />
          <ReasoningContent>controlled content</ReasoningContent>
        </Reasoning>
      );
    }
    render(<Controlled />);
    expect(screen.getByText('controlled content').closest('[data-state]')?.getAttribute('data-state')).toBe('closed');

    fireEvent.click(screen.getByRole('button'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByText('controlled content')).toBeInTheDocument();
  });

  it('shows "a few seconds" copy when there is no duration yet, and accepts a duration prop directly', () => {
    const { rerender } = render(<Basic />);
    expect(screen.getByText('Thought for a few seconds')).toBeInTheDocument();

    rerender(<Basic duration={7} />);
    expect(screen.getByText('Thought for 7 seconds')).toBeInTheDocument();
  });

  it('renders custom trigger children instead of the default thinking message', () => {
    render(
      <Reasoning>
        <ReasoningTrigger>Custom trigger label</ReasoningTrigger>
        <ReasoningContent>content</ReasoningContent>
      </Reasoning>,
    );
    expect(screen.getByText('Custom trigger label')).toBeInTheDocument();
  });

  it('supports a custom getThinkingMessage renderer', () => {
    render(
      <Reasoning isStreaming>
        <ReasoningTrigger getThinkingMessage={(streaming) => (streaming ? <span>Working…</span> : <span>Done</span>)} />
        <ReasoningContent>content</ReasoningContent>
      </Reasoning>,
    );
    expect(screen.getByText('Working…')).toBeInTheDocument();
  });

  it('throws when Reasoning subcomponents are used outside <Reasoning>', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ReasoningTrigger />)).toThrow('Reasoning components must be used within Reasoning');
    spy.mockRestore();
  });
});
