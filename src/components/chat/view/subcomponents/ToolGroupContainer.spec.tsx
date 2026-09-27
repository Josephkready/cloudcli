import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

import ToolGroupContainer from './ToolGroupContainer';
import type { ChatMessage } from '../../types/types';
import type { ToolGroupItem } from '../../utils/toolGrouping';

/**
 * Uses vitest/jsdom: the collapse/expand button relies on real click events
 * and state, and the expanded body renders MessageComponent for real (which
 * transitively renders Markdown.tsx via some tool content types), so this
 * cannot run under node:test.
 *
 * MessageComponent is NOT mocked — one test below exercises the real nested
 * render (a Read tool row appearing once expanded) so the composition isn't
 * vacuous. The rest of the tests focus on ToolGroupContainer's own logic:
 * label/icon derivation, the preview string, and expand/collapse.
 */

function toolMessage(toolName: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00.000Z',
    isToolUse: true,
    toolName,
    ...extra,
  } as ChatMessage;
}

function makeGroup(toolName: string, messages: ChatMessage[], timestamp: ChatMessage['timestamp'] = '2026-01-01T00:00:00.000Z'): ToolGroupItem {
  return { _isGroup: true, toolName, messages, timestamp };
}

const baseProps = {
  prevMessage: null,
  createDiff: () => [],
  getMessageKey: (m: ChatMessage) => `${m.toolId || m.toolName}-${m.timestamp}`,
  provider: 'anthropic',
};

describe('ToolGroupContainer', () => {
  it('renders the tool label, icon, and message count', () => {
    const group = makeGroup('Read', [
      toolMessage('Read', { toolInput: { file_path: '/a.ts' } }),
      toolMessage('Read', { toolInput: { file_path: '/b.ts' } }),
    ]);
    render(<ToolGroupContainer group={group} {...baseProps} />);
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('x2')).toBeInTheDocument();
  });

  it('renders the terminal glyph for a Bash group instead of its configured icon key', () => {
    const group = makeGroup('Bash', [
      toolMessage('Bash', { toolInput: { command: 'ls' } }),
      toolMessage('Bash', { toolInput: { command: 'pwd' } }),
    ]);
    render(<ToolGroupContainer group={group} {...baseProps} />);
    expect(screen.getByText('$')).toBeInTheDocument();
  });

  it('falls back to the first letter of the tool name when no icon or label is configured', () => {
    const group = makeGroup('WeirdTool', [
      toolMessage('WeirdTool', { toolInput: {} }),
      toolMessage('WeirdTool', { toolInput: {} }),
    ]);
    render(<ToolGroupContainer group={group} {...baseProps} />);
    // Default config has no label, so the tool name itself is used as the label...
    expect(screen.getByText('WeirdTool')).toBeInTheDocument();
    // ...and the icon falls back to its first letter, uppercased.
    expect(screen.getByText('W')).toBeInTheDocument();
  });

  describe('preview text', () => {
    it('joins up to two visible previews and counts the rest as "+N more"', () => {
      const group = makeGroup('Read', [
        toolMessage('Read', { toolInput: { file_path: '/a.ts' } }),
        toolMessage('Read', { toolInput: { file_path: '/b.ts' } }),
        toolMessage('Read', { toolInput: { file_path: '/c.ts' } }),
      ]);
      render(<ToolGroupContainer group={group} {...baseProps} />);
      expect(screen.getByText('/a.ts, /b.ts, +1 more')).toBeInTheDocument();
    });

    it('does not append a "+N more" suffix when every message produces a preview and none are hidden', () => {
      const group = makeGroup('Read', [
        toolMessage('Read', { toolInput: { file_path: '/a.ts' } }),
        toolMessage('Read', { toolInput: { file_path: '/b.ts' } }),
      ]);
      render(<ToolGroupContainer group={group} {...baseProps} />);
      expect(screen.getByText('/a.ts, /b.ts')).toBeInTheDocument();
      expect(screen.queryByText(/more/)).not.toBeInTheDocument();
    });

    it('parses stringified JSON tool input for the preview', () => {
      const group = makeGroup('Grep', [
        toolMessage('Grep', { toolInput: JSON.stringify({ pattern: 'TODO' }) }),
        toolMessage('Grep', { toolInput: JSON.stringify({ pattern: 'FIXME' }) }),
      ]);
      render(<ToolGroupContainer group={group} {...baseProps} />);
      expect(screen.getByText('TODO, FIXME')).toBeInTheDocument();
    });

    it('falls back to displayText when a malformed-JSON tool input parses to no usable value or title (Bash)', () => {
      // Bash's config has no `title` and getValue reads `.command` off an
      // object — a non-JSON string input leaves `.command` undefined, so the
      // preview must fall all the way back to the message's own displayText.
      const group = makeGroup('Bash', [
        toolMessage('Bash', { toolInput: 'not-json-input', displayText: 'raw fallback one' }),
        toolMessage('Bash', { toolInput: 'not-json-input-2', displayText: 'raw fallback two' }),
      ]);
      render(<ToolGroupContainer group={group} {...baseProps} />);
      expect(screen.getByText('raw fallback one, raw fallback two')).toBeInTheDocument();
    });

    it('falls back to displayText/content when the tool config yields no value or title', () => {
      const group = makeGroup('TaskCreate', [
        toolMessage('TaskCreate', { toolInput: { subject: 'Ship it' } }),
        toolMessage('TaskCreate', { toolInput: {} }),
      ]);
      render(<ToolGroupContainer group={group} {...baseProps} />);
      expect(screen.getByText('Ship it, Creating task')).toBeInTheDocument();
    });
  });

  describe('expand / collapse', () => {
    it('starts collapsed and does not render child messages', () => {
      const group = makeGroup('Read', [toolMessage('Read', { toolInput: { file_path: '/a.ts' } }), toolMessage('Read', { toolInput: { file_path: '/b.ts' } })]);
      render(<ToolGroupContainer group={group} {...baseProps} />);
      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-expanded', 'false');
    });

    it('expands on click and renders real nested MessageComponent rows for each grouped message', () => {
      const group = makeGroup('Read', [
        toolMessage('Read', { toolInput: { file_path: '/src/a.ts' }, toolId: 'id-1' }),
        toolMessage('Read', { toolInput: { file_path: '/src/b.ts' }, toolId: 'id-2' }),
      ]);
      render(<ToolGroupContainer group={group} {...baseProps} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'true');

      // Each grouped Read message renders through the real MessageComponent ->
      // ToolRenderer -> OneLineDisplay chain, showing its file path.
      expect(screen.getByText('a.ts')).toBeInTheDocument();
      expect(screen.getByText('b.ts')).toBeInTheDocument();
    });

    it('collapses again on a second click', () => {
      const group = makeGroup('Read', [
        toolMessage('Read', { toolInput: { file_path: '/src/a.ts' }, toolId: 'coll-1' }),
        toolMessage('Read', { toolInput: { file_path: '/src/b.ts' }, toolId: 'coll-2' }),
      ]);
      render(<ToolGroupContainer group={group} {...baseProps} />);
      const button = screen.getByRole('button');
      fireEvent.click(button);
      expect(screen.getByText('a.ts')).toBeInTheDocument();
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('a.ts')).not.toBeInTheDocument();
    });

    it('threads prevMessage correctly: the first grouped message gets the container prevMessage, later ones get their predecessor', () => {
      const priorMessage = toolMessage('Bash', { toolInput: { command: 'echo before' }, toolId: 'prior' });
      const group = makeGroup('Read', [
        toolMessage('Read', { toolInput: { file_path: '/src/a.ts' }, toolId: 'id-1' }),
        toolMessage('Read', { toolInput: { file_path: '/src/b.ts' }, toolId: 'id-2' }),
      ]);
      const getMessageKey = vi.fn((m: ChatMessage) => String(m.toolId));
      render(
        <ToolGroupContainer
          group={group}
          prevMessage={priorMessage}
          createDiff={() => []}
          getMessageKey={getMessageKey}
          provider="anthropic"
        />,
      );
      fireEvent.click(screen.getByRole('button'));
      expect(getMessageKey).toHaveBeenCalledWith(group.messages[0]);
      expect(getMessageKey).toHaveBeenCalledWith(group.messages[1]);
    });
  });

  it('forwards onFileOpen/onShowSettings/onGrantToolPermission/showRawParameters/showThinking/selectedProject to child messages', () => {
    const onFileOpen = vi.fn();
    const group = makeGroup('Read', [
      toolMessage('Read', { toolInput: { file_path: '/src/a.ts' }, toolId: 'fwd-1' }),
      toolMessage('Read', { toolInput: { file_path: '/src/b.ts' }, toolId: 'fwd-2' }),
    ]);
    render(
      <ToolGroupContainer
        group={group}
        {...baseProps}
        onFileOpen={onFileOpen}
        showRawParameters
        showThinking
        selectedProject={null}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('a.ts'));
    expect(onFileOpen).toHaveBeenCalledWith('/src/a.ts');
  });

  it('sets the message-timestamp data attribute from the group timestamp', () => {
    const group = makeGroup('Read', [toolMessage('Read', { toolInput: {} }), toolMessage('Read', { toolInput: {} })], 'ts-123' as unknown as ChatMessage['timestamp']);
    const { container } = render(<ToolGroupContainer group={group} {...baseProps} />);
    expect(container.querySelector('[data-message-timestamp="ts-123"]')).toBeInTheDocument();
  });
});
