import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../../../types/app';

import { useChatComposerState } from './useChatComposerState';

vi.mock('./useSlashCommands', () => ({
  useSlashCommands: () => ({
    slashCommands: [],
    filteredCommands: [],
    frequentCommands: [],
    commandQuery: '',
    showCommandMenu: false,
    selectedCommandIndex: 0,
    resetCommandMenuState: vi.fn(),
    handleCommandSelect: vi.fn(),
    handleToggleCommandMenu: vi.fn(),
    handleCommandInputChange: vi.fn(),
    handleCommandMenuKeyDown: () => false,
  }),
}));

vi.mock('./useFileMentions', () => ({
  useFileMentions: () => ({
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    renderInputWithMentions: () => null,
    selectFile: vi.fn(),
    setCursorPosition: vi.fn(),
    handleFileMentionsKeyDown: () => false,
  }),
}));

const SESSION_ID = 'sess-347';

function makeProps(sendMessage: ReturnType<typeof vi.fn>, isLoading: boolean) {
  return {
    selectedProject: {
      projectId: 'project-1',
      displayName: 'Demo',
      path: '/workspace/demo',
      fullPath: '/workspace/demo',
    } satisfies Project,
    selectedSession: { id: SESSION_ID, __provider: 'claude' } satisfies ProjectSession,
    currentSessionId: SESSION_ID,
    provider: 'claude' as const,
    permissionMode: 'default' as const,
    cyclePermissionMode: vi.fn(),
    resolvePermissionModeForProvider: (_p: unknown, mode: unknown) => mode as 'default',
    claudeModel: 'claude-test',
    codexModel: 'gpt-test',
    antigravityModel: 'gemini-alt',
    currentProviderEffort: 'default' as const,
    isLoading,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage,
    scrollToBottom: vi.fn(),
    addMessage: vi.fn(),
    setIsUserScrolledUp: vi.fn(),
    setPendingPermissionRequests: vi.fn(),
  };
}

const submitEvent = () => ({ preventDefault: vi.fn() }) as unknown as FormEvent<HTMLFormElement>;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const sendsOf = (sendMessage: ReturnType<typeof vi.fn>, content: string) =>
  sendMessage.mock.calls.filter(
    ([frame]) => (frame as { type?: string; content?: string })?.type === 'chat.send'
      && (frame as { content?: string }).content === content,
  );

/**
 * #347 — "somehow a message got sent twice".
 *
 * Evidence from the reporter's transcript: one 697-character prompt reached
 * Claude five times, and every arrival landed 1-2s after an assistant turn
 * finished (01:10:55, 01:18:27, 01:18:44, 01:28:09, 01:28:31). That is the
 * queue-drain completion edge firing over and over on a queue entry that was
 * never actually consumed — so the invariant under test is simply: one queued
 * message produces exactly one send, no matter how many runs complete after it.
 */
describe('useChatComposerState — a queued message is delivered exactly once (#347)', () => {
  it('does not re-send the queued message on every subsequent completion edge', async () => {
    const sendMessage = vi.fn();
    const { result, rerender } = renderHook(
      (p: ReturnType<typeof makeProps>) => useChatComposerState(p),
      { initialProps: makeProps(sendMessage, true) },
    );

    const CONTENT = 'I want to add a new feature to wall display.';
    act(() => {
      result.current.setInput(CONTENT);
    });
    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });
    expect(sendsOf(sendMessage, CONTENT)).toHaveLength(0);

    // Four runs complete in a row, exactly as the transcript shows. The first
    // edge legitimately drains the queue; the next three must find it empty.
    for (let edge = 0; edge < 4; edge += 1) {
      await act(async () => {
        rerender(makeProps(sendMessage, false));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await act(async () => {
        rerender(makeProps(sendMessage, true));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    }

    expect(sendsOf(sendMessage, CONTENT)).toHaveLength(1);
  });

  it('leaves the persisted queue empty once the message has been delivered', async () => {
    const sendMessage = vi.fn();
    const { result, rerender } = renderHook(
      (p: ReturnType<typeof makeProps>) => useChatComposerState(p),
      { initialProps: makeProps(sendMessage, true) },
    );

    act(() => {
      result.current.setInput('queued once');
    });
    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });
    await act(async () => {
      rerender(makeProps(sendMessage, false));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // A queue that still holds the message is what re-fires on the next edge.
    expect(localStorage.getItem(`queued_message_${SESSION_ID}`)).toBeNull();
    expect(result.current.queuedDrafts).toHaveLength(0);
  });

  it('delivers two distinct queued messages once each, in order', async () => {
    const sendMessage = vi.fn();
    const { result, rerender } = renderHook(
      (p: ReturnType<typeof makeProps>) => useChatComposerState(p),
      { initialProps: makeProps(sendMessage, true) },
    );

    for (const text of ['first queued', 'second queued']) {
      act(() => {
        result.current.setInput(text);
      });
      await act(async () => {
        await result.current.handleSubmit(submitEvent());
      });
    }

    for (let edge = 0; edge < 3; edge += 1) {
      await act(async () => {
        rerender(makeProps(sendMessage, false));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await act(async () => {
        rerender(makeProps(sendMessage, true));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    }

    expect(sendsOf(sendMessage, 'first queued')).toHaveLength(1);
    expect(sendsOf(sendMessage, 'second queued')).toHaveLength(1);
    const order = sendMessage.mock.calls
      .map(([frame]) => (frame as { content?: string })?.content)
      .filter((content) => content === 'first queued' || content === 'second queued');
    expect(order).toEqual(['first queued', 'second queued']);
  });
});
