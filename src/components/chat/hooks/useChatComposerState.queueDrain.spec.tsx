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

const SESSION_ID = 'sess-318';

function makeProps(sendMessage: ReturnType<typeof vi.fn>, isLoading: boolean) {
  return {
    selectedProject: {
      projectId: 'project-1',
      displayName: 'Demo',
      path: '/workspace/demo',
      fullPath: '/workspace/demo',
    } satisfies Project,
    selectedSession: {
      id: SESSION_ID,
      __provider: 'claude',
    } satisfies ProjectSession,
    currentSessionId: SESSION_ID,
    provider: 'claude' as const,
    permissionMode: 'default' as const,
    cyclePermissionMode: vi.fn(),
    resolvePermissionModeForProvider: (
      _provider: unknown,
      requestedMode: unknown,
    ) => requestedMode as 'default',
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

/**
 * Regression lock for #318 — "press send and nothing happens".
 *
 * `handleSubmit` deliberately QUEUES instead of sending while a run is in
 * flight, clearing the textarea as it does. That is correct on its own, but it
 * means the queue drain is the only thing that ever delivers the message. If
 * the drain does not fire, the user sees a composer that silently eats input.
 */
describe('useChatComposerState — queued message drain (#318)', () => {
  it('queues instead of sending while a run is in flight', async () => {
    const sendMessage = vi.fn();
    const { result } = renderHook((p: ReturnType<typeof makeProps>) => useChatComposerState(p), {
      initialProps: makeProps(sendMessage, true),
    });

    act(() => {
      result.current.setInput('message typed during a run');
    });
    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });

    // Nothing sent, and the textarea was cleared — the "dead composer" symptom.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.input).toBe('');
  });

  it('delivers the queued message once the in-flight run completes', async () => {
    const sendMessage = vi.fn();
    const { result, rerender } = renderHook(
      (p: ReturnType<typeof makeProps>) => useChatComposerState(p),
      { initialProps: makeProps(sendMessage, true) },
    );

    act(() => {
      result.current.setInput('message typed during a run');
    });
    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });
    expect(sendMessage).not.toHaveBeenCalled();

    // The run completes: isLoading falls true -> false. This is the completion
    // edge the drain keys on.
    await act(async () => {
      rerender(makeProps(sendMessage, false));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.send',
        sessionId: SESSION_ID,
        content: 'message typed during a run',
      }),
    );
  });

  it('delivers a queue restored while the session is already idle', async () => {
    // The stuck case from #318: the completion edge was missed (a stale
    // processing entry meant the client never observed true -> false), so the
    // queue is discovered on an already-idle session. It must still drain
    // rather than sit there forever.
    const sendMessage = vi.fn();
    const { result } = renderHook((p: ReturnType<typeof makeProps>) => useChatComposerState(p), {
      initialProps: makeProps(sendMessage, false),
    });

    act(() => {
      result.current.setInput('typed while idle');
    });
    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });

    // Idle send goes straight out — no queueing involved.
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'typed while idle' }),
    );
  });
});
