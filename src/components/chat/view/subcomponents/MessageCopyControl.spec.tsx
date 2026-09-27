import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import MessageCopyControl from './MessageCopyControl';

// Interaction coverage for #151's copy control: clicking copies to the
// clipboard and shows transient "copied" feedback, and the assistant variant's
// format dropdown opens, lists options, selects one, and closes on outside
// click / scroll. The static-rendering tests in MessageCopyControl.test.tsx
// (node:test) cover the structural error/user/assistant split; these exercise
// the actual event handlers via a real DOM.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MessageCopyControl interactions', () => {
  it('copies the content to the clipboard and shows a "copied" state that clears itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: async () => '' },
    });

    render(<MessageCopyControl content="hello world" messageType="user" />);
    const copyButton = screen.getByRole('button', { name: /copy/i });

    await fireEvent.click(copyButton);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('hello world'));

    // The button's title flips to "Copied" while `copied` is true.
    await waitFor(() => expect(copyButton.title.toLowerCase()).toContain('copied'));

    vi.advanceTimersByTime(2100);
    await waitFor(() => expect(copyButton.title.toLowerCase()).not.toContain('copied'));
    vi.useRealTimers();
  });

  it('does nothing when the payload is empty/whitespace-only', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: async () => '' },
    });

    render(<MessageCopyControl content="   " messageType="user" />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('opens the format dropdown, lists markdown/text options, and selects one', () => {
    render(<MessageCopyControl content="# heading" messageType="assistant" />);

    fireEvent.click(screen.getByRole('button', { name: /select copy format/i }));
    expect(screen.getByText('Copy as markdown')).toBeTruthy();
    expect(screen.getByText('Copy as text')).toBeTruthy();

    fireEvent.click(screen.getByText('Copy as text'));

    // Selecting a format closes the dropdown and updates the format tag.
    expect(screen.queryByText('Copy as markdown')).toBeNull();
    expect(screen.getByText('TXT')).toBeTruthy();
  });

  it('closes the dropdown on outside click', () => {
    render(
      <div>
        <div data-testid="outside">outside</div>
        <MessageCopyControl content="# heading" messageType="assistant" />
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: /select copy format/i }));
    expect(screen.getByText('Copy as markdown')).toBeTruthy();

    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByText('Copy as markdown')).toBeNull();
  });

  it('closes the dropdown on scroll and toggles closed on a second trigger click', () => {
    render(<MessageCopyControl content="# heading" messageType="assistant" />);
    const trigger = screen.getByRole('button', { name: /select copy format/i });

    fireEvent.click(trigger);
    expect(screen.getByText('Copy as markdown')).toBeTruthy();

    fireEvent.scroll(window);
    expect(screen.queryByText('Copy as markdown')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByText('Copy as markdown')).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByText('Copy as markdown')).toBeNull();
  });

  it('resets to the default format when messageType changes', () => {
    const { rerender } = render(<MessageCopyControl content="x" messageType="assistant" />);
    fireEvent.click(screen.getByRole('button', { name: /select copy format/i }));
    fireEvent.click(screen.getByText('Copy as text'));
    expect(screen.getByText('TXT')).toBeTruthy();

    rerender(<MessageCopyControl content="x" messageType="error" />);
    expect(screen.getByText('TXT')).toBeTruthy();
  });
});
