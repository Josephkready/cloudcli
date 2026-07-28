import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../../../types/app';

import { useChatComposerState } from './useChatComposerState';

vi.mock('react-dropzone', () => ({
  useDropzone: () => ({
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    open: vi.fn(),
  }),
}));

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

beforeEach(() => {
  localStorage.clear();
});

describe('useChatComposerState — Antigravity send options', () => {
  it('forwards the selected Antigravity model in chat.send', async () => {
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useChatComposerState({
      selectedProject: {
        projectId: 'project-1',
        displayName: 'Demo',
        path: '/workspace/demo',
        fullPath: '/workspace/demo',
      } satisfies Project,
      selectedSession: {
        id: 'agy-app-session',
        __provider: 'antigravity',
      } satisfies ProjectSession,
      currentSessionId: 'agy-app-session',
      provider: 'antigravity',
      permissionMode: 'default',
      cyclePermissionMode: vi.fn(),
      resolvePermissionModeForProvider: (_provider, requestedMode) => requestedMode as 'default',
      claudeModel: 'claude-test',
      codexModel: 'gpt-test',
      antigravityModel: 'gemini-alt',
      currentProviderEffort: 'default',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage,
      scrollToBottom: vi.fn(),
      addMessage: vi.fn(),
      setIsUserScrolledUp: vi.fn(),
      setPendingPermissionRequests: vi.fn(),
    }));

    act(() => {
      result.current.setInput('hello from agy');
    });
    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as FormEvent<HTMLFormElement>);
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.send',
      sessionId: 'agy-app-session',
      content: 'hello from agy',
      options: expect.objectContaining({
        model: 'gemini-alt',
        effort: 'default',
      }),
    }));
  });
});
