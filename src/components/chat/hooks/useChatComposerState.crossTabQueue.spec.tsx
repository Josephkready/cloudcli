import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../../../types/app';
import { queuedMessageKey, readQueuedMessages, writeQueuedMessages } from '../utils/chatStorage';

import { reconcileQueuedDraftsFromStorage, useChatComposerState, type QueuedDraft } from './useChatComposerState';

/**
 * #459 item 3 (loss direction): two tabs on ONE session share the single
 * `queued_message_<id>` key. The persistence effect writes this tab's in-memory
 * queue over it, so without adopting the other tab's writes a stale tab would
 * clobber a message the other tab queued. A cross-tab `storage` listener keeps
 * the viewed session's queue in sync so the next persist can't lose it.
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

const SESSION_ID = 'session-459-3';

// --- pure reconcile helper -------------------------------------------------

const draft = (id: string, content: string): QueuedDraft => ({ id, content, images: [] });
let idSeq = 0;
const makeId = () => `new_${idSeq++}`;

describe('reconcileQueuedDraftsFromStorage', () => {
  beforeEach(() => {
    idSeq = 0;
  });

  it('returns null when in-memory and storage already match, so no state churn', () => {
    const current = [draft('a', 'one'), draft('b', 'two')];
    const stored = [{ content: 'one' }, { content: 'two' }];
    expect(reconcileQueuedDraftsFromStorage(current, stored, makeId)).toBeNull();
  });

  it('adopts a message another tab appended, preserving existing ids by content', () => {
    const current = [draft('a', 'one')];
    const stored = [{ content: 'one' }, { content: 'two', options: { model: 'x' } }];

    const result = reconcileQueuedDraftsFromStorage(current, stored, makeId);

    expect(result).not.toBeNull();
    expect(result?.map((d) => d.content)).toEqual(['one', 'two']);
    expect(result?.[0].id).toBe('a'); // survivor keeps its stable React id
    expect(result?.[1].id).toBe('new_0'); // the new item gets a fresh id
    expect(result?.[1].options).toEqual({ model: 'x' });
  });

  it('adopts a drain another tab made (message removed from storage)', () => {
    const current = [draft('a', 'one'), draft('b', 'two')];
    const stored = [{ content: 'two' }];

    const result = reconcileQueuedDraftsFromStorage(current, stored, makeId);

    expect(result?.map((d) => d.content)).toEqual(['two']);
    expect(result?.[0].id).toBe('b'); // the surviving draft keeps its id
  });

  it('preserves in-memory image attachments for a surviving message', () => {
    const image = new File(['x'], 'x.png', { type: 'image/png' });
    const current: QueuedDraft[] = [{ id: 'a', content: 'one', images: [image] }];
    const stored = [{ content: 'one' }, { content: 'two' }];

    const result = reconcileQueuedDraftsFromStorage(current, stored, makeId);

    expect(result?.[0].images).toEqual([image]); // images never persist, kept from memory
    expect(result?.[1].images).toEqual([]);
  });

  it('keeps the image-bearing survivor when a duplicate-content draft is removed', () => {
    // Storage carries no id, so which of two identical "foo" drafts the other tab
    // removed is ambiguous; the surviving one must keep its attachment, not drop it.
    const image = new File(['x'], 'x.png', { type: 'image/png' });
    const current: QueuedDraft[] = [
      { id: 'a', content: 'foo', images: [] },
      { id: 'c', content: 'foo', images: [image] },
    ];
    const stored = [{ content: 'foo' }];

    const result = reconcileQueuedDraftsFromStorage(current, stored, makeId);

    expect(result?.map((d) => d.content)).toEqual(['foo']);
    expect(result?.[0].images).toEqual([image]); // the attachment survives
  });
});

// --- hook-level cross-tab sync ---------------------------------------------

type ComposerArgs = Parameters<typeof useChatComposerState>[0];

function makeProps(isLoading: boolean): ComposerArgs {
  return {
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
    resolvePermissionModeForProvider: (_p, requestedMode) => requestedMode as 'default',
    claudeModel: 'claude-test',
    codexModel: 'gpt-test',
    antigravityModel: 'gemini-test',
    currentProviderEffort: 'default',
    isLoading,
    canAbortSession: isLoading,
    tokenBudget: null,
    sendMessage: vi.fn(() => true),
    onSessionProcessing: vi.fn(),
    scrollToBottom: vi.fn(),
    addMessage: vi.fn(),
    setIsUserScrolledUp: vi.fn(),
    setPendingPermissionRequests: vi.fn(),
  };
}

function setup() {
  // isLoading: true so a submit QUEUES rather than sends.
  return renderHook(() => useChatComposerState(makeProps(true)));
}

/** Simulates another tab writing the shared queue and the resulting storage event. */
function otherTabWrites(contents: string[]) {
  const newValue = contents.length
    ? JSON.stringify(contents.map((content) => ({ content })))
    : null;
  if (newValue === null) {
    localStorage.removeItem(queuedMessageKey(SESSION_ID));
  } else {
    localStorage.setItem(queuedMessageKey(SESSION_ID), newValue);
  }
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: queuedMessageKey(SESSION_ID), newValue, storageArea: localStorage }),
    );
  });
}

async function queueMessage(rendered: ReturnType<typeof setup>, text: string) {
  act(() => {
    rendered.result.current.setInput(text);
  });
  await act(async () => {
    await rendered.result.current.handleSubmit({ preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>);
  });
}

describe('useChatComposerState — cross-tab queue sync (#459 item 3)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adopts a message another tab queued for the viewed session', async () => {
    const rendered = setup();
    expect(rendered.result.current.queuedDrafts).toEqual([]);

    otherTabWrites(['from other tab']);

    expect(rendered.result.current.queuedDrafts.map((d) => d.content)).toEqual(['from other tab']);
  });

  it('does not clobber the other tab\'s queued message on the next persist (loss prevention)', async () => {
    const rendered = setup();

    // Another tab queues X while this tab's in-memory queue is still empty.
    otherTabWrites(['X from tab A']);
    // This tab then queues its own Y. Its persist must include X, not overwrite it.
    await queueMessage(rendered, 'Y from tab B');

    expect(rendered.result.current.queuedDrafts.map((d) => d.content)).toEqual(['X from tab A', 'Y from tab B']);
    expect(readQueuedMessages(SESSION_ID).map((m) => m.content)).toEqual(['X from tab A', 'Y from tab B']);
  });

  it('adopts a drain another tab made, dropping the message here too', async () => {
    // Seed a shared queue, then mount (restores [gone, kept]).
    writeQueuedMessages(SESSION_ID, [{ content: 'gone' }, { content: 'kept' }]);
    const rendered = setup();
    expect(rendered.result.current.queuedDrafts.map((d) => d.content)).toEqual(['gone', 'kept']);

    // The other tab drains the head.
    otherTabWrites(['kept']);

    expect(rendered.result.current.queuedDrafts.map((d) => d.content)).toEqual(['kept']);
  });

  it('adopts a full drain-to-empty (the other tab removed the shared key)', async () => {
    writeQueuedMessages(SESSION_ID, [{ content: 'only' }]);
    const rendered = setup();
    expect(rendered.result.current.queuedDrafts.map((d) => d.content)).toEqual(['only']);

    otherTabWrites([]); // removeItem + event with the session key and null value

    expect(rendered.result.current.queuedDrafts).toEqual([]);
  });

  it('ignores storage events for other keys', async () => {
    writeQueuedMessages(SESSION_ID, [{ content: 'mine' }]);
    const rendered = setup();

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'draft_input_project-1', newValue: 'unrelated', storageArea: localStorage }),
      );
    });

    expect(rendered.result.current.queuedDrafts.map((d) => d.content)).toEqual(['mine']);
  });

  it('does not wipe the queue on an unrelated storage.clear() from another tab', async () => {
    writeQueuedMessages(SESSION_ID, [{ content: 'still composing' }]);
    const rendered = setup();

    // Simulate another tab's storage.clear(): the key really is gone from storage,
    // and the event carries a null key. Syncing to empty on it would discard a
    // message still queued here, so it must be ignored (in-memory self-heals on
    // the next persist). If the null key were NOT ignored, the handler would read
    // the now-empty store and wipe the in-memory queue.
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null, storageArea: localStorage }));
    });

    expect(rendered.result.current.queuedDrafts.map((d) => d.content)).toEqual(['still composing']);
  });

  it('does not re-persist when a storage event matches the current queue (no ping-pong)', async () => {
    writeQueuedMessages(SESSION_ID, [{ content: 'in sync' }]);
    const rendered = setup(); // mount restores + persists ['in sync'] before the spy below

    // Spy AFTER mount so only a re-persist triggered by the event would register.
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    // Storage already holds ['in sync'], so an event carrying that same value must
    // reconcile to a no-op: no setQueuedDrafts, hence no persist. Otherwise two
    // synced tabs would ping-pong identical writes forever. Dispatch the event
    // directly (no setItem) so any write the spy sees is this tab re-persisting.
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: queuedMessageKey(SESSION_ID),
          newValue: JSON.stringify([{ content: 'in sync' }]),
          storageArea: localStorage,
        }),
      );
    });

    const queueWrites = setItemSpy.mock.calls.filter(([key]) => key === queuedMessageKey(SESSION_ID));
    expect(queueWrites).toHaveLength(0);
    expect(rendered.result.current.queuedDrafts.map((d) => d.content)).toEqual(['in sync']);
  });
});
