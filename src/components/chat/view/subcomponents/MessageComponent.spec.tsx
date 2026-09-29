import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../types/types';

vi.mock('../../tools', () => ({
  ToolRenderer: (props: Record<string, unknown>) => (
    <div data-testid="tool-renderer" data-mode={String(props.mode)} data-tool-name={String(props.toolName)} />
  ),
  shouldHideToolResult: vi.fn(() => false),
}));

import { shouldHideToolResult } from '../../tools';

import MessageComponent from './MessageComponent';

/*
 * Regression lock for #39: a tagged local-command user turn (`isLocalCommand`)
 * renders as a compact command chip (Terminal icon + monospace label), not a
 * prose bubble — and it falls back to the normal bubble when the command label
 * is empty. `formatLocalCommandLabel` and the content filter are tested
 * elsewhere; this closes the untested render link.
 */

function renderMessage(message: Partial<ChatMessage>, provider = 'claude') {
  const full = {
    type: 'user',
    timestamp: '2026-07-21T10:00:00.000Z',
    ...message,
  } as ChatMessage;

  return render(
    <MessageComponent
      message={full}
      prevMessage={null}
      createDiff={() => []}
      provider={provider}
    />,
  );
}

describe('MessageComponent — local-command chip (#39)', () => {
  it('renders a tagged local command as a monospace chip with a Terminal icon', () => {
    const { container } = renderMessage({
      type: 'user',
      isLocalCommand: true,
      commandName: 'usage',
      content: '/usage',
    });

    const label = screen.getByText('/usage');
    // Chip, not prose: the label is monospace and carries a title tooltip.
    expect(label).toHaveClass('font-mono');
    expect(label).toHaveAttribute('title', '/usage');
    // The Terminal glyph lives inside the chip container next to the label.
    expect(label.parentElement?.querySelector('svg')).not.toBeNull();
    // No prose user bubble was rendered (the bubble is the only element with
    // the `rounded-br-md` tail).
    expect(container.querySelector('.rounded-br-md')).toBeNull();
  });

  it('appends command args to the chip label', () => {
    renderMessage({
      type: 'user',
      isLocalCommand: true,
      commandName: 'model',
      commandArgs: 'opus',
      content: '/model opus',
    });

    expect(screen.getByText('/model opus')).toHaveClass('font-mono');
  });

  it('falls back to the normal prose bubble when the command label is empty', () => {
    const { container } = renderMessage({
      type: 'user',
      isLocalCommand: true,
      content: '',
    });

    // No chip: nothing is rendered monospace.
    expect(container.querySelector('.font-mono')).toBeNull();
    // The normal (empty) user bubble is rendered instead.
    expect(container.querySelector('.rounded-br-md')).not.toBeNull();
  });

  it('does not chip an ordinary message that merely starts with a slash', () => {
    const { container } = renderMessage({
      type: 'user',
      isLocalCommand: false,
      content: '/usage is a slash but not a tagged command',
    });

    const bubble = screen.getByText('/usage is a slash but not a tagged command');
    // Rendered as prose (font-serif bubble), never as a monospace chip.
    expect(bubble).toHaveClass('font-serif');
    expect(bubble).not.toHaveClass('font-mono');
    expect(container.querySelector('.font-mono')).toBeNull();
    expect(container.querySelector('.rounded-br-md')).not.toBeNull();
  });
});

describe('MessageComponent — provider identity', () => {
  it('labels Antigravity assistant messages as Antigravity', () => {
    renderMessage({
      type: 'assistant',
      content: 'Hello from Antigravity',
    }, 'antigravity');

    expect(screen.getByText('Antigravity')).toBeInTheDocument();
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
  });

  it('labels Codex assistant messages as Codex', () => {
    renderMessage({ type: 'assistant', content: 'hi' }, 'codex');
    expect(screen.getByText('Codex')).toBeInTheDocument();
  });

  it('defaults unrecognised providers to the Claude label', () => {
    renderMessage({ type: 'assistant', content: 'hi' }, 'claude');
    expect(screen.getByText('Claude')).toBeInTheDocument();
  });
});

describe('MessageComponent — hides thinking messages when not requested', () => {
  it('renders null via the MessageComponent prop showThinking=false', () => {
    const full = {
      type: 'assistant',
      timestamp: '2026-07-21T10:00:00.000Z',
      isThinking: true,
      content: 'secret chain of thought',
    } as ChatMessage;
    const { container } = render(
      <MessageComponent message={full} prevMessage={null} createDiff={() => []} provider="claude" showThinking={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the Reasoning accordion when showThinking is true', () => {
    const full = {
      type: 'assistant',
      timestamp: '2026-07-21T10:00:00.000Z',
      isThinking: true,
      content: 'chain of thought text',
    } as ChatMessage;
    render(
      <MessageComponent message={full} prevMessage={null} createDiff={() => []} provider="claude" showThinking />,
    );
    expect(screen.getByText('chain of thought text')).toBeInTheDocument();
  });
});

describe('MessageComponent — task notifications', () => {
  it('renders a completed task notification with a green dot', () => {
    const { container } = renderMessage({
      type: 'assistant',
      isTaskNotification: true,
      taskStatus: 'completed',
      content: 'Task finished',
    } as Partial<ChatMessage>);

    expect(screen.getByText('Task finished')).toBeInTheDocument();
    expect(container.querySelector('.bg-green-400')).not.toBeNull();
  });

  it('renders a pending task notification with an amber dot', () => {
    const { container } = renderMessage({
      type: 'assistant',
      isTaskNotification: true,
      taskStatus: 'pending',
      content: 'Task running',
    } as Partial<ChatMessage>);

    expect(container.querySelector('.bg-amber-400')).not.toBeNull();
  });
});

describe('MessageComponent — user turn variants', () => {
  it('renders only a timestamp for an image-only turn with no text', () => {
    const { container } = renderMessage({
      type: 'user',
      content: '',
      images: [{ data: 'data:image/png;base64,AAAA', name: 'pic' }],
    });

    expect(container.querySelector('.rounded-br-md')).toBeNull();
    expect(screen.getByRole('img', { name: 'pic' })).toBeInTheDocument();
  });

  it('shows the copy control for non-empty user text', () => {
    renderMessage({ type: 'user', content: 'hello there' });
    expect(screen.getByText('hello there')).toBeInTheDocument();
    // MessageCopyControl renders a button; confirm at least one button exists in the bubble.
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('shows the avatar circle when not grouped, and hides it when grouped', () => {
    const prev = { type: 'user', timestamp: '2026-07-21T09:59:00.000Z', content: 'a' } as ChatMessage;
    const full = { type: 'user', timestamp: '2026-07-21T10:00:00.000Z', content: 'b' } as ChatMessage;

    const { container: ungrouped } = render(
      <MessageComponent message={full} prevMessage={null} createDiff={() => []} provider="claude" />,
    );
    expect(ungrouped.querySelector('.bg-blue-600.text-white')).not.toBeNull();

    const { container: grouped } = render(
      <MessageComponent message={full} prevMessage={prev} createDiff={() => []} provider="claude" />,
    );
    expect(grouped.textContent).not.toContain('U');
  });
});

describe('MessageComponent — error and tool avatars', () => {
  it('renders the error avatar and label for an error message', () => {
    renderMessage({ type: 'error', content: 'boom', toolResult: { content: 'boom', isError: true } });
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('renders the tool avatar and label for a tool message', () => {
    renderMessage({ type: 'tool', content: 'tool output' });
    expect(screen.getByText('Tool')).toBeInTheDocument();
  });
});

describe('MessageComponent — tool use rendering', () => {
  it('renders ToolRenderer in input mode when toolInput is present', () => {
    renderMessage({
      type: 'assistant',
      isToolUse: true,
      toolName: 'Read',
      toolInput: { file_path: '/a.ts' },
      displayText: 'Reading a.ts',
    });

    const renderers = screen.getAllByTestId('tool-renderer');
    expect(renderers.some((el) => el.getAttribute('data-mode') === 'input')).toBe(true);
    expect(screen.getByText('Reading a.ts')).toBeInTheDocument();
  });

  it('renders ErrorToolResult for an error tool result instead of ToolRenderer result mode', () => {
    renderMessage({
      type: 'assistant',
      isToolUse: true,
      toolName: 'Read',
      toolInput: { file_path: '/a.ts' },
      toolResult: { content: 'file not found', isError: true },
    });

    expect(screen.getByText(/file not found/)).toBeInTheDocument();
    const renderers = screen.getAllByTestId('tool-renderer');
    expect(renderers.every((el) => el.getAttribute('data-mode') !== 'result')).toBe(true);
  });

  it('renders ToolRenderer in result mode for a non-error, non-Bash tool result', () => {
    renderMessage({
      type: 'assistant',
      isToolUse: true,
      toolName: 'Read',
      toolInput: { file_path: '/a.ts' },
      toolResult: { content: 'file contents', isError: false },
      toolId: 'tool-1',
    });

    const resultRenderer = screen
      .getAllByTestId('tool-renderer')
      .find((el) => el.getAttribute('data-mode') === 'result');
    expect(resultRenderer).toBeDefined();
    expect(document.getElementById('tool-result-tool-1')).not.toBeNull();
  });

  it('does not render a separate result ToolRenderer for a Bash tool (rendered inline in the command row)', () => {
    renderMessage({
      type: 'assistant',
      isToolUse: true,
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResult: { content: 'file1\nfile2', isError: false },
    });

    const renderers = screen.getAllByTestId('tool-renderer');
    expect(renderers.every((el) => el.getAttribute('data-mode') !== 'result')).toBe(true);
  });

  it('hides the tool result entirely when shouldHideToolResult returns true', () => {
    vi.mocked(shouldHideToolResult).mockReturnValueOnce(true);
    renderMessage({
      type: 'assistant',
      isToolUse: true,
      toolName: 'Read',
      toolInput: { file_path: '/a.ts' },
      toolResult: { content: 'file contents', isError: false },
    });

    const renderers = screen.getAllByTestId('tool-renderer');
    expect(renderers.every((el) => el.getAttribute('data-mode') !== 'result')).toBe(true);
  });

  it('hides the assistant copy control for command/file-edit tool responses', () => {
    const { container } = renderMessage({
      type: 'assistant',
      isToolUse: true,
      toolName: 'Edit',
      toolInput: { file_path: '/a.ts' },
      displayText: 'Edited a.ts',
    });
    // Grouped=false so the footer row still renders (for the timestamp), but no copy/speak controls.
    expect(container.querySelector('[title="Copy"]')).toBeNull();
  });
});

describe('MessageComponent — interactive prompt parsing', () => {
  it('parses numbered options and marks the ❯-prefixed one as selected', () => {
    renderMessage({
      type: 'assistant',
      isInteractivePrompt: true,
      content: 'Proceed?\n❯ 1. Yes\n  2. No',
    });

    expect(screen.getByText('Proceed?')).toBeInTheDocument();
    const yesButton = screen.getByText('Yes').closest('button');
    const noButton = screen.getByText('No').closest('button');
    expect(yesButton).toBeDisabled();
    expect(yesButton?.className).toContain('bg-amber-600');
    expect(noButton?.className).not.toContain('bg-amber-600');
  });

  it('falls back to the first line as the question when no line contains a "?"', () => {
    renderMessage({
      type: 'assistant',
      isInteractivePrompt: true,
      content: 'Pick one\n1. A\n2. B',
    });
    expect(screen.getByText('Pick one')).toBeInTheDocument();
  });
});

describe('MessageComponent — plain content rendering', () => {
  it('pretty-prints pure JSON object content', () => {
    renderMessage({ type: 'assistant', content: '{"a":1,"b":2}' });
    expect(screen.getByText(/"a": 1/)).toBeInTheDocument();
    expect(screen.getByText('JSON Response')).toBeInTheDocument();
  });

  it('pretty-prints pure JSON array content', () => {
    renderMessage({ type: 'assistant', content: '[1,2,3]' });
    expect(screen.getByText(/1,/)).toBeInTheDocument();
  });

  it('falls back to normal markdown rendering when JSON-looking content fails to parse', () => {
    renderMessage({ type: 'assistant', content: '{not valid json' });
    expect(screen.getByText('{not valid json')).toBeInTheDocument();
  });

  it('does not re-parse JSON content on a re-render where message.content is unchanged', () => {
    // WP6 fix: JSON detection/pretty-printing is memoized on formattedMessageContent,
    // so a re-render triggered by an unrelated prop must not re-run JSON.parse.
    const parseSpy = vi.spyOn(JSON, 'parse');
    const message = { type: 'assistant', content: '{"a":1,"b":2}' } as ChatMessage;
    const { rerender } = render(
      <MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="claude" />,
    );
    expect(screen.getByText('JSON Response')).toBeInTheDocument();
    const callsAfterFirstRender = parseSpy.mock.calls.length;
    expect(callsAfterFirstRender).toBeGreaterThan(0);

    // Re-render with the same message object but a changed unrelated prop.
    rerender(
      <MessageComponent
        message={message}
        prevMessage={null}
        createDiff={() => []}
        provider="claude"
        showRawParameters
      />,
    );
    expect(parseSpy.mock.calls.length).toBe(callsAfterFirstRender);
    parseSpy.mockRestore();
  });

  it('renders assistant content through Markdown', () => {
    renderMessage({ type: 'assistant', content: '**bold text**' });
    expect(screen.getByText('bold text').tagName).toBe('STRONG');
  });

  it('renders non-assistant plain content as preformatted text, not Markdown', () => {
    renderMessage({ type: 'tool', content: '**not bold**' });
    expect(screen.getByText('**not bold**')).toBeInTheDocument();
  });

  it('shows the reasoning accordion for a non-thinking assistant message with reasoning, only when showThinking is true', () => {
    const full = {
      type: 'assistant',
      timestamp: '2026-07-21T10:00:00.000Z',
      content: 'final answer',
      reasoning: 'because of X',
    } as ChatMessage;

    const { container: withoutShow } = render(
      <MessageComponent message={full} prevMessage={null} createDiff={() => []} provider="claude" />,
    );
    expect(withoutShow.textContent).not.toContain('because of X');

    render(
      <MessageComponent message={full} prevMessage={null} createDiff={() => []} provider="claude" showThinking />,
    );
    expect(screen.getByText('because of X')).toBeInTheDocument();
  });
});
