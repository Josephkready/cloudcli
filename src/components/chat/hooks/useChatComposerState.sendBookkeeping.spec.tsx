import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../../../types/app';

import { useChatComposerState } from './useChatComposerState';

/**
 * #450 / #448 — the invisible send.
 *
 * Once `sendMessage` returns true the frame is the server's: it is running or
 * queued, and the client cannot recall it. Everything `handleSubmit` does after
 * that point is what tells the user it happened.
 *
 * `addMessage` sat in the middle of that tail, and it can throw — it routes
 * into the shared session store, which a single malformed realtime frame (an
 * id-less `chat_resumed`) was enough to poison. When it threw, the whole tail
 * was skipped: no bubble, no spinner, and the user's text still sitting in the
 * composer. `handleSubmit` is `async`, so the throw surfaced only as an
 * unhandled rejection — nothing in the UI, no error boundary.
 *
 * From the user's side that is indistinguishable from a send that did not go
 * out, so they press send again. Every press mints a fresh `pendingSendId`,
 * which is the exact key `chat.send` dedupes on, so the server cannot collapse
 * the copies — and since #198 it queues and runs each one. A transcript in the
 * wild holds the same message three times, with three matching run spawns.
 *
 * These tests assert the user-facing contract directly: after an accepted send,
 * the composer is empty, the activity indicator is on, and the draft is gone —
 * whether or not the optimistic bubble could be rendered.
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

const SESSION_ID = 'session-450';
const DRAFT_KEY = 'draft_input_project-1';

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

interface SetupOptions {
  /** Simulates a poisoned session store taking the optimistic bubble down. */
  addMessageThrows?: boolean;
  sendMessage?: (message: unknown) => boolean;
}

function setup({ addMessageThrows = false, sendMessage = () => true }: SetupOptions = {}) {
  const sent: unknown[] = [];
  /** Call order of the post-dispatch steps, for the ordering guard below. */
  const order: string[] = [];
  const addMessage = vi.fn(() => {
    order.push('addMessage');
    if (addMessageThrows) {
      throw new TypeError("Cannot read properties of undefined (reading 'startsWith')");
    }
  });
  const onSessionProcessing = vi.fn(() => {
    order.push('onSessionProcessing');
  });
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
    sendMessage: (message: unknown) => {
      sent.push(message);
      return sendMessage(message);
    },
    onSessionProcessing,
    scrollToBottom: vi.fn(),
    addMessage,
    setIsUserScrolledUp: vi.fn(),
    setPendingPermissionRequests: vi.fn(),
  }));
  return { rendered, addMessage, onSessionProcessing, sent, order };
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

const chatSends = (sent: unknown[]) =>
  sent.filter((m) => (m as { type?: string })?.type === 'chat.send');

describe('handleSubmit bookkeeping survives a failing optimistic bubble (#450)', () => {
  it('does not reject', async () => {
    const { rendered } = setup({ addMessageThrows: true });
    await expect(submit(rendered, 'send me once')).resolves.toBe(true);
  });

  it('clears the composer', async () => {
    const { rendered } = setup({ addMessageThrows: true });
    await submit(rendered, 'send me once');

    // THE bug. Text left in the box after an accepted send reads as "that
    // didn't work", and the user presses send again.
    expect(rendered.result.current.input).toBe('');
  });

  it('turns the activity indicator on', async () => {
    const { rendered, onSessionProcessing } = setup({ addMessageThrows: true });
    await submit(rendered, 'send me once');

    // The other half of the feedback: without a spinner there is nothing at all
    // to show the run started.
    expect(onSessionProcessing).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({
      canInterrupt: true,
    }));
  });

  it('removes the saved draft', async () => {
    const { rendered } = setup({ addMessageThrows: true });
    await submit(rendered, 'send me once');

    // A surviving draft would repopulate the composer on remount — the same
    // "still unsent" illusion, made durable.
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('did try to render the bubble', async () => {
    const { rendered, addMessage } = setup({ addMessageThrows: true });
    await submit(rendered, 'send me once');

    // Guards the test itself: if `addMessage` were never called, everything
    // above would pass for the wrong reason.
    expect(addMessage).toHaveBeenCalled();
  });

  it('does not send a second copy when the user submits again', async () => {
    const { rendered, sent } = setup({ addMessageThrows: true });
    await submit(rendered, 'send me once');

    // The real sequence: the user sees an empty composer, so there is nothing
    // left to re-submit. An empty submit must be a no-op.
    await act(async () => {
      await rendered.result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as FormEvent<HTMLFormElement>);
    });

    expect(chatSends(sent)).toHaveLength(1);
  });

  it('reports the failure somewhere a developer can find it', async () => {
    const { rendered } = setup({ addMessageThrows: true });
    await submit(rendered, 'send me once');

    // It was an unhandled promise rejection before — invisible in the UI and
    // easy to miss in the console.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('the message was still sent'),
      // Correlation context, so the line can be tied to a specific send in a
      // busy console.
      expect.objectContaining({ sessionId: SESSION_ID }),
      expect.any(TypeError),
    );
  });
});

describe('handleSubmit bookkeeping on the happy path is unchanged', () => {
  it('clears the composer and marks the run started', async () => {
    const { rendered, onSessionProcessing, addMessage } = setup();
    const returned = await submit(rendered, 'normal message');

    expect(returned).toBe(true);
    expect(rendered.result.current.input).toBe('');
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(onSessionProcessing).toHaveBeenCalled();
    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user',
      content: 'normal message',
    }));
  });

  it('flips the indicator, then renders the bubble, then clears the input', async () => {
    // Ordering guard. The indicator goes first because it is a plain flag with
    // no store involvement — it is the feedback that survives even when the
    // bubble cannot render. The bubble stays ahead of the composer reset so
    // there is never a frame showing an empty box and no message, which is the
    // same "did that send?" illusion from the other direction. Unfailability
    // comes from the `finally`, not from reordering the reset to the front.
    const { rendered, order } = setup();
    await submit(rendered, 'ordering');

    expect(order).toEqual(['onSessionProcessing', 'addMessage']);
    expect(rendered.result.current.input).toBe('');
  });
});

describe('an undispatched send still behaves as before (#325)', () => {
  it('leaves the activity indicator off and clears the composer', async () => {
    const { rendered, onSessionProcessing } = setup({ sendMessage: () => false });
    const returned = await submit(rendered, 'offline text');

    expect(returned).toBe(false);
    expect(onSessionProcessing).not.toHaveBeenCalled();
    expect(rendered.result.current.input).toBe('');
  });
});
