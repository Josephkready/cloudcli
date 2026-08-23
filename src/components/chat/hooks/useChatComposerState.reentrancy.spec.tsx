import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../types/app';
import { authenticatedFetch } from '../../../utils/api';

import { useChatComposerState } from './useChatComposerState';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
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

const project = {
  projectId: 'project-1',
  displayName: 'Demo',
  path: '/workspace/demo',
  fullPath: '/workspace/demo',
} satisfies Project;

const submitEvent = () => ({ preventDefault: vi.fn() }) as unknown as FormEvent<HTMLFormElement>;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.mocked(authenticatedFetch).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useChatComposerState submit reentrancy', () => {
  it('creates and dispatches only one new session for concurrent submits', async () => {
    let resolveCreation: ((response: Response) => void) | undefined;
    vi.mocked(authenticatedFetch).mockReturnValue(
      new Promise<Response>((resolve) => { resolveCreation = resolve; }),
    );
    const sendMessage = vi.fn(() => true);
    const onSessionEstablished = vi.fn();
    const { result } = renderHook(() => useChatComposerState({
      selectedProject: project,
      selectedSession: null,
      currentSessionId: null,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: vi.fn(),
      resolvePermissionModeForProvider: (_provider, mode) => mode as 'default',
      claudeModel: 'claude-test',
      codexModel: 'gpt-test',
      antigravityModel: 'gemini-test',
      currentProviderEffort: 'default',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage,
      onSessionEstablished,
      scrollToBottom: vi.fn(),
      addMessage: vi.fn(),
      setIsUserScrolledUp: vi.fn(),
      setPendingPermissionRequests: vi.fn(),
    }));

    act(() => {
      result.current.setInput('do this once');
    });

    let firstSubmit: Promise<boolean>;
    act(() => {
      firstSubmit = result.current.handleSubmit(submitEvent());
    });
    let secondResult: boolean | undefined;
    await act(async () => {
      secondResult = await result.current.handleSubmit(submitEvent());
    });

    expect(secondResult).toBe(false);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreation?.(new Response(JSON.stringify({ data: { sessionId: 'new-session' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await firstSubmit!;
    });

    expect(onSessionEstablished).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.send',
      sessionId: 'new-session',
      content: 'do this once',
    }));
  });
});
