import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../../../types/app';
import { readPendingSends } from '../utils/pendingSends';

import { useChatComposerState } from './useChatComposerState';

/**
 * #325: a message sent while the connection was down looked delivered and was
 * then gone for good — never sent, the optimistic bubble in memory only, and the
 * draft key already cleared. These pin the composer half of the fix: the message
 * is recorded durably BEFORE the send, and a send that didn't happen is never
 * reported as one that did.
 */

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

const SESSION_ID = 'session-325';
const DRAFT_KEY = 'draft_input_project-1';

beforeEach(() => {
  localStorage.clear();
});

function setup(sendMessage: (message: unknown) => boolean) {
  const addMessage = vi.fn();
  const onSessionProcessing = vi.fn();
  const rendered = renderHook(() => useChatComposerState({
    selectedProject: {
      projectId: 'project-1',
      displayName: 'Demo',
      path: '/workspace/demo',
      fullPath: '/workspace/demo',
    } satisfies Project,
    selectedSession: { id: SESSION_ID } satisfies ProjectSession,
    currentSessionId: SESSION_ID,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: vi.fn(),
    resolvePermissionModeForProvider: (_provider, requestedMode) => requestedMode as 'default',
    claudeModel: 'claude-test',
    codexModel: 'gpt-test',
    antigravityModel: 'gemini-test',
    currentProviderEffort: 'default',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage,
    onSessionProcessing,
    scrollToBottom: vi.fn(),
    addMessage,
    setIsUserScrolledUp: vi.fn(),
    setPendingPermissionRequests: vi.fn(),
  }));
  return { rendered, addMessage, onSessionProcessing };
}

async function submit(rendered: ReturnType<typeof setup>['rendered'], text: string) {
  act(() => {
    rendered.result.current.setInput(text);
  });
  let returned: unknown;
  await act(async () => {
    returned = await rendered.result.current.handleSubmit({
      preventDefault: vi.fn(),
    } as unknown as FormEvent<HTMLFormElement>);
  });
  return returned;
}

describe('useChatComposerState — a send that never reached the server (#325)', () => {
  it('persists the message before handing it to the socket', async () => {
    const { rendered } = setup(() => true);
    await submit(rendered, 'remember me');

    const pending = readPendingSends(SESSION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.content).toBe('remember me');
    // Sending is not confirmation — the entry stays until the server echoes it,
    // because a half-open socket accepts a frame it never delivers.
    expect(pending[0]?.timestamp).toBeTruthy();
  });

  it('does not report a run as started when the frame was not written', async () => {
    const { rendered, onSessionProcessing } = setup(() => false);
    const returned = await submit(rendered, 'lost message');

    expect(returned).toBe(false);
    // The activity indicator is what made an undelivered message look like one
    // awaiting a reply.
    expect(onSessionProcessing).not.toHaveBeenCalled();
  });

  it('keeps the undelivered message durably so it can be resent later', async () => {
    const { rendered } = setup(() => false);
    await submit(rendered, 'lost message');

    const pending = readPendingSends(SESSION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.content).toBe('lost message');
    // Flagged as never delivered, which is what lets it be resent immediately
    // rather than waiting out the in-flight grace period.
    expect(pending[0]?.dispatched).toBe(false);
  });

  it('stops flagging a message as undelivered once the socket accepts it', async () => {
    const { rendered } = setup(() => true);
    await submit(rendered, 'delivered');

    // Still pending (only a server echo confirms it), but no longer the
    // known-never-sent case — so a resend waits out the grace period instead of
    // racing the transcript indexer and duplicating the message.
    expect(readPendingSends(SESSION_ID)[0]?.dispatched).not.toBe(false);
  });

  it('tells the user it has not been sent rather than showing it as delivered', async () => {
    const { rendered, addMessage } = setup(() => false);
    await submit(rendered, 'lost message');

    const contents = addMessage.mock.calls.map(([message]) => message);
    expect(contents.some((m) => m.type === 'user' && m.content === 'lost message')).toBe(true);
    const notice = contents.find((m) => m.type === 'error');
    expect(notice).toBeTruthy();
    expect(notice.content).toMatch(/offline/i);
    expect(notice.content).toMatch(/sent automatically|when the connection/i);
  });

  it('marks the run as started on a successful send', async () => {
    const { rendered, onSessionProcessing } = setup(() => true);
    const returned = await submit(rendered, 'delivered');

    expect(returned).toBe(true);
    expect(onSessionProcessing).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({
      canInterrupt: true,
    }));
  });

  it('clears the draft either way, since the text is captured durably', async () => {
    // Leaving the draft behind would double up with the pending entry and
    // re-send on the next submit.
    const offline = setup(() => false);
    await submit(offline.rendered, 'offline text');
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();

    localStorage.clear();
    const online = setup(() => true);
    await submit(online.rendered, 'online text');
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('keeps each session\'s undelivered messages separate and ordered', async () => {
    const { rendered } = setup(() => false);
    await submit(rendered, 'first');
    await submit(rendered, 'second');

    expect(readPendingSends(SESSION_ID).map((e) => e.content)).toEqual(['first', 'second']);
    expect(readPendingSends('some-other-session')).toEqual([]);
  });
});
