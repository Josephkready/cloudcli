import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../../../types/app';
import { queuedMessageKey, readQueuedMessages } from '../utils/chatStorage';

import { useChatComposerState } from './useChatComposerState';

/**
 * #330: quota recovery used to delete every `queued_message_*` key to make
 * room, discarding messages the user had typed and queued with nothing but a
 * console.warn. It no longer touches them — which means a genuinely full store
 * now refuses the write instead, and that has to be visible rather than silent.
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

const SESSION_ID = 'session-330';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Makes the store reject writes to one key class, as a full disk would. */
function refuseWritesTo(prefix: string) {
  const real = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(this: Storage, key, value) {
    if (String(key).startsWith(prefix)) {
      const error = new Error('quota');
      error.name = 'QuotaExceededError';
      throw error;
    }
    real.call(this, key, value);
  });
}

function setup() {
  const addMessage = vi.fn();
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
    // A turn is in flight, so a submit queues rather than sends — the path
    // whose only durable copy is the storage key under test.
    isLoading: true,
    canAbortSession: true,
    tokenBudget: null,
    sendMessage: vi.fn(() => true),
    onSessionProcessing: vi.fn(),
    scrollToBottom: vi.fn(),
    addMessage,
    setIsUserScrolledUp: vi.fn(),
    setPendingPermissionRequests: vi.fn(),
  }));
  return { rendered, addMessage };
}

async function queueMessage(rendered: ReturnType<typeof setup>['rendered'], text: string) {
  act(() => {
    rendered.result.current.setInput(text);
  });
  await act(async () => {
    await rendered.result.current.handleSubmit({
      preventDefault: vi.fn(),
    } as unknown as FormEvent<HTMLFormElement>);
  });
}

const storageNotices = (addMessage: ReturnType<typeof vi.fn>) =>
  addMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === 'error' && /storage is full/i.test(message.content));

describe('useChatComposerState — queue persistence (#330)', () => {
  it('persists a queued message and says nothing when storage accepts it', async () => {
    const { rendered, addMessage } = setup();
    await queueMessage(rendered, 'refactor the parser please');

    expect(readQueuedMessages(SESSION_ID)).toEqual([
      { content: 'refactor the parser please', options: expect.any(Object) },
    ]);
    expect(storageNotices(addMessage)).toHaveLength(0);
  });

  it('tells the user when the queue could not be saved', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    refuseWritesTo('queued_message_');

    const { rendered, addMessage } = setup();
    await queueMessage(rendered, 'the message that must not vanish');

    // Nothing durable was written...
    expect(localStorage.getItem(queuedMessageKey(SESSION_ID))).toBeNull();
    // ...so the user is told, instead of finding it gone after a reload.
    const [notice] = storageNotices(addMessage);
    expect(notice).toBeTruthy();
    expect(notice.content).toMatch(/still be sent/i);
    expect(notice.content).toMatch(/reload/i);
    // The message is still queued in memory and will go out on this turn's end.
    expect(rendered.result.current.queuedDrafts.map((d) => d.content))
      .toEqual(['the message that must not vanish']);
  });

  it('keeps an existing queue when a later write is refused', async () => {
    const { rendered } = setup();
    await queueMessage(rendered, 'first');
    const stored = localStorage.getItem(queuedMessageKey(SESSION_ID));
    expect(stored).toBeTruthy();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    refuseWritesTo('queued_message_');
    await queueMessage(rendered, 'second');

    // The refused write leaves the earlier queue intact rather than clearing it.
    expect(localStorage.getItem(queuedMessageKey(SESSION_ID))).toBe(stored);
  });
});
