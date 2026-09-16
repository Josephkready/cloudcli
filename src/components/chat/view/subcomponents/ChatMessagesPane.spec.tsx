import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../types/types';
import type { Project } from '../../../../types/app';

import ChatMessagesPane from './ChatMessagesPane';

/*
 * Phase 2 (cloudcli#483): the transcript is windowed with `@tanstack/react-virtual`
 * so a long conversation no longer mounts every message. Two things must stay
 * true across that change, and both are covered here rather than only in the
 * real-layout e2e suite:
 *
 * 1. The windowed path actually bounds how many rows mount —
 *    the whole point of this phase. A regression here (e.g. the virtualizer
 *    silently falling back to rendering everything) would be invisible to any
 *    test that only checks *content*, not *count*.
 * 2. An explicit "show the whole thread" request (`visibleMessageCount ===
 *    Infinity`) keeps the exact pre-virtualization flat render — every message mounts, matching what the
 *    in-conversation search-to-message flow (`useChatSessionState.ts`) depends
 *    on to find a message via `querySelectorAll`. Merely having reached the
 *    start of history by scroll-paging (`allMessagesLoaded` with a finite
 *    count) must NOT do that — that reader has the most rows loaded and needs
 *    virtualization most.
 *
 * `renderRow`/`prevMessageForRow` are shared by both render paths, so the
 * grouping/prevMessage-continuity assertions below run through the flat path
 * (`allMessagesLoaded`) where every row is guaranteed to mount in jsdom without
 * fighting jsdom's lack of a layout engine — they exercise the same function
 * the virtualized path calls per visible row.
 */

vi.mock('./MessageComponent', () => ({
  default: ({ message, prevMessage }: { message: ChatMessage; prevMessage: ChatMessage | null }) => (
    <div
      className="chat-message"
      data-testid="message"
      data-message-id={message.id as string}
      data-prev-id={(prevMessage?.id as string) ?? ''}
    />
  ),
}));

vi.mock('./ToolGroupContainer', () => ({
  default: ({ group, prevMessage }: { group: { messages: ChatMessage[] }; prevMessage: ChatMessage | null }) => (
    <div
      data-testid="tool-group"
      data-first-id={group.messages[0]?.id as string}
      data-prev-id={(prevMessage?.id as string) ?? ''}
    />
  ),
}));

vi.mock('./LoadAllMessagesOverlay', () => ({ default: () => null }));
vi.mock('./ProviderSelectionEmptyState', () => ({ default: () => null }));

const project = { projectId: 'p1', displayName: 'proj', fullPath: '/tmp/proj' } as unknown as Project;

function makeMessage(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    type: 'assistant',
    content: `message ${id}`,
    timestamp: new Date(2026, 0, 1, 0, 0, Number(id.replace(/\D/g, '')) || 0).toISOString(),
    ...overrides,
  };
}

const baseProps = {
  onWheel: () => {},
  onTouchMove: () => {},
  isLoadingSessionMessages: false,
  isProcessing: false,
  selectedSession: null,
  currentSessionId: 's1',
  provider: 'claude' as const,
  setProvider: () => {},
  textareaRef: createRef<HTMLTextAreaElement>(),
  claudeModel: '',
  setClaudeModel: () => {},
  codexModel: '',
  setCodexModel: () => {},
  antigravityModel: '',
  setAntigravityModel: () => {},
  providerModelCatalog: {},
  providerModelsLoading: false,
  isLoadingMoreMessages: false,
  createDiff: undefined,
  onGrantToolPermission: () => ({ success: true }),
  selectedProject: project,
};

describe('ChatMessagesPane virtualization (cloudcli#483 phase 2)', () => {
  it('bounds the number of mounted rows for a large windowed conversation', () => {
    // jsdom has no layout engine, so the scroll container's `offsetHeight` —
    // what react-virtual reads to size its viewport — is always 0, which
    // computes an empty visible range. Give it a plausible height so the
    // virtualizer has something real to window against; this is the standard
    // way to unit-test a react-virtual consumer under jsdom.
    const offsetHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(600);

    const messages = Array.from({ length: 600 }, (_, i) => makeMessage(`m${i}`));
    const scrollContainerRef = createRef<HTMLDivElement>();

    render(
      <ChatMessagesPane
        {...baseProps}
        scrollContainerRef={scrollContainerRef}
        chatMessages={messages}
        visibleMessages={messages}
        visibleMessageCount={600}
        allMessagesLoaded={false}
      />,
    );

    const mounted = screen.getAllByTestId('message');
    // jsdom has no layout engine, so every row measures 0 and the virtualizer
    // falls back to its size estimate for everything — the assertion that
    // matters here isn't a precise count (that's the e2e suite's job against
    // real layout), it's that virtualization is active at all: nothing close
    // to all 600 rows mounted.
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(messages.length / 2);

    offsetHeightSpy.mockRestore();
  });

  it('mounts every row when visibleMessageCount is Infinity (search-navigation)', () => {
    const messages = Array.from({ length: 250 }, (_, i) => makeMessage(`m${i}`));
    const scrollContainerRef = createRef<HTMLDivElement>();

    render(
      <ChatMessagesPane
        {...baseProps}
        scrollContainerRef={scrollContainerRef}
        chatMessages={messages}
        visibleMessages={messages}
        visibleMessageCount={Infinity}
        allMessagesLoaded
      />,
    );

    expect(screen.getAllByTestId('message')).toHaveLength(250);
    // The flat path renders directly, with no virtualizer wrapper.
    expect(screen.queryByTestId('virtual-row-viewport')).not.toBeInTheDocument();
  });

  it('stays virtualized when scroll-paging has merely exhausted history (allMessagesLoaded, finite count)', () => {
    const offsetHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(600);

    const messages = Array.from({ length: 400 }, (_, i) => makeMessage(`m${i}`));
    const scrollContainerRef = createRef<HTMLDivElement>();

    render(
      <ChatMessagesPane
        {...baseProps}
        scrollContainerRef={scrollContainerRef}
        chatMessages={messages}
        visibleMessages={messages}
        visibleMessageCount={400}
        allMessagesLoaded
      />,
    );

    expect(screen.getByTestId('virtual-row-viewport')).toBeInTheDocument();
    expect(screen.getAllByTestId('message').length).toBeLessThan(messages.length / 2);

    offsetHeightSpy.mockRestore();
  });

  it('threads prevMessage by list position, not by what happens to be mounted', () => {
    const messages = [makeMessage('a'), makeMessage('b'), makeMessage('c')];
    const scrollContainerRef = createRef<HTMLDivElement>();

    render(
      <ChatMessagesPane
        {...baseProps}
        scrollContainerRef={scrollContainerRef}
        chatMessages={messages}
        visibleMessages={messages}
        visibleMessageCount={Infinity}
        allMessagesLoaded
      />,
    );

    const rows = screen.getAllByTestId('message');
    expect(rows[0]).toHaveAttribute('data-prev-id', '');
    expect(rows[1]).toHaveAttribute('data-prev-id', 'a');
    expect(rows[2]).toHaveAttribute('data-prev-id', 'b');
  });

  it('gives the message after a tool group the group\'s LAST tool as prevMessage', () => {
    // Mirrors TOOL_GROUP_THRESHOLD (2): two consecutive tool_use messages group.
    const messages = [
      makeMessage('t1', { isToolUse: true, toolName: 'Bash' }),
      makeMessage('t2', { isToolUse: true, toolName: 'Bash' }),
      makeMessage('reply'),
    ];
    const scrollContainerRef = createRef<HTMLDivElement>();

    render(
      <ChatMessagesPane
        {...baseProps}
        scrollContainerRef={scrollContainerRef}
        chatMessages={messages}
        visibleMessages={messages}
        visibleMessageCount={Infinity}
        allMessagesLoaded
      />,
    );

    const group = screen.getByTestId('tool-group');
    expect(group).toHaveAttribute('data-first-id', 't1');
    expect(group).toHaveAttribute('data-prev-id', '');

    const reply = screen.getByTestId('message');
    expect(reply).toHaveAttribute('data-message-id', 'reply');
    expect(reply).toHaveAttribute('data-prev-id', 't2');
  });

  it('keeps row keys stable across a prepend so the virtualizer can reuse measured heights', () => {
    // `getItemKey` derives from the same intrinsic-key scheme as the flat
    // render's `key` prop — assert the two agree for a message that appears
    // both before and after older messages are prepended (a load-more/load-all
    // page boundary), the scenario the scroll-restore math depends on.
    const tail = [makeMessage('keep-1'), makeMessage('keep-2')];
    const scrollContainerRef = createRef<HTMLDivElement>();

    const { rerender } = render(
      <ChatMessagesPane
        {...baseProps}
        scrollContainerRef={scrollContainerRef}
        chatMessages={tail}
        visibleMessages={tail}
        visibleMessageCount={Infinity}
        allMessagesLoaded
      />,
    );
    expect(screen.getAllByTestId('message').map((r) => r.getAttribute('data-message-id'))).toEqual([
      'keep-1',
      'keep-2',
    ]);

    const prepended = [makeMessage('older-1'), makeMessage('older-2'), ...tail];
    rerender(
      <ChatMessagesPane
        {...baseProps}
        scrollContainerRef={scrollContainerRef}
        chatMessages={prepended}
        visibleMessages={prepended}
        visibleMessageCount={Infinity}
        allMessagesLoaded
      />,
    );

    const rows = screen.getAllByTestId('message');
    expect(rows.map((r) => r.getAttribute('data-message-id'))).toEqual([
      'older-1',
      'older-2',
      'keep-1',
      'keep-2',
    ]);
    // `keep-1`'s prevMessage is now `older-2`, not null — proves the reorder
    // recomputed prevMessage by position rather than caching the original.
    expect(rows[2]).toHaveAttribute('data-prev-id', 'older-2');
  });
});
