import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SHARED_TEXT_KEY } from '../../../pwa/launchParams';
import type { Project } from '../../../types/app';

import { useChatComposerState } from './useChatComposerState';

/**
 * The composer claiming text shared into the app from elsewhere (issue #370).
 *
 * A share arrives as a launch parameter, often before any project is selected,
 * so it is parked under one key and claimed here at the first moment there is a
 * per-project draft to put it in. Two things must hold and neither is visible
 * without a test: it is claimed exactly ONCE (or switching projects pastes it
 * again), and it APPENDS (or it silently eats a draft the user had already
 * typed).
 */

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

const project = (projectId: string): Project => ({
  projectId,
  displayName: 'Demo',
  path: '/workspace/demo',
  fullPath: '/workspace/demo',
});

function mount(projectId: string) {
  return renderHook(
    ({ id }: { id: string }) => useChatComposerState({
      selectedProject: project(id),
      selectedSession: null,
      currentSessionId: null,
      provider: 'claude',
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
      sendMessage: vi.fn(() => true),
      scrollToBottom: vi.fn(),
      addMessage: vi.fn(),
      setIsUserScrolledUp: vi.fn(),
      setPendingPermissionRequests: vi.fn(),
    }),
    { initialProps: { id: projectId } },
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('claiming a parked share', () => {
  it('seeds the composer with the shared text', () => {
    localStorage.setItem(SHARED_TEXT_KEY, 'https://example.com/article');

    const { result } = mount('project-1');

    expect(result.current.input).toBe('https://example.com/article');
  });

  it('clears the parked share once claimed', () => {
    localStorage.setItem(SHARED_TEXT_KEY, 'shared once');

    mount('project-1');

    expect(localStorage.getItem(SHARED_TEXT_KEY)).toBeNull();
  });

  it('does not paste the share again when the project changes', () => {
    localStorage.setItem(SHARED_TEXT_KEY, 'shared once');

    const view = mount('project-1');
    expect(view.result.current.input).toBe('shared once');

    // Switching projects re-runs the draft effect. Without the claim being
    // one-shot, the share would reappear in every project the user visits.
    view.rerender({ id: 'project-2' });

    expect(view.result.current.input).toBe('');
  });

  it('appends to an existing draft instead of replacing it', () => {
    // The draft is the user's own unsent writing; a share must never eat it.
    localStorage.setItem('draft_input_project-1', 'my half-written question');
    localStorage.setItem(SHARED_TEXT_KEY, 'https://example.com/article');

    const { result } = mount('project-1');

    expect(result.current.input).toBe(
      'my half-written question\n\nhttps://example.com/article',
    );
  });

  it('leaves no stray separator when there is no existing draft', () => {
    localStorage.setItem(SHARED_TEXT_KEY, 'just this');

    const { result } = mount('project-1');

    expect(result.current.input).toBe('just this');
  });

  it('leaves an ordinary draft untouched when nothing was shared', () => {
    localStorage.setItem('draft_input_project-1', 'just my draft');

    const { result } = mount('project-1');

    expect(result.current.input).toBe('just my draft');
  });
});
