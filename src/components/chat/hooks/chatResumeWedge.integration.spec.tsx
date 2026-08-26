import { act, renderHook } from '@testing-library/react';
import { useRef, useCallback } from 'react';
import type { FormEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import { useSessionStore } from '../../../stores/useSessionStore';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { LLMProvider, Project, ProjectSession } from '../../../types/app';
import type { ChatMessage } from '../types/types';

import { useChatComposerState } from './useChatComposerState';
import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

/**
 * #450 / #448 / #389 — the whole chain, end to end.
 *
 * The three unit suites each pin one link. This one reproduces the reported bug
 * itself, with the real session store, the real realtime handler, and the real
 * composer wired together — nothing mocked but the network and the socket.
 *
 * The chain, as it happened in the wild:
 *
 *   1. A run is stranded by a server restart, so the Resume banner appears.
 *   2. The user clicks Resume. The server answers `chat_resumed` — a hand-rolled
 *      gateway frame with no `id`.
 *   3. The realtime handler did not recognise the kind, and its persist rule was
 *      an exclude-list, so it appended the frame into the session transcript.
 *   4. The merge dereferenced `message.id` and threw. The row was already in the
 *      slot, so it stayed: `merged` froze and every later append threw too.
 *   5. The user types and presses send. `sendMessage` succeeds — the server
 *      starts the run — but `addMessage` throws inside the frozen slot, so the
 *      rest of `handleSubmit` never runs. No bubble, no spinner, text still in
 *      the composer.
 *   6. It looks like nothing happened, so they press send again. Each press
 *      mints a fresh `clientMessageId`, which is the key the server dedupes on,
 *      so every copy runs. One session's transcript holds the same message three
 *      times, with three matching run spawns.
 *
 * Step 6 is the damage; steps 2-5 are the mechanism. This test drives 1-5 and
 * asserts the user-visible outcome the fix has to produce.
 */

const mockFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => mockFetch(...args),
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

const SESSION = 'session-resume-wedge';

const serverRow = (id: string, role: 'user' | 'assistant', content: string, ms: number) => ({
  id,
  sessionId: SESSION,
  kind: 'text',
  role,
  content,
  provider: 'claude',
  timestamp: new Date(1_700_000_000_000 + ms).toISOString(),
});

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => ({ data: body }) };
}

/**
 * Mirrors `useChatSessionState.addMessage`: mint a `local_*` optimistic row and
 * hand it to the store. Deliberately correct — the point is that a perfectly
 * well-formed row still blew up, because the POISON was already in the slot.
 */
function useRealAddMessage(store: ReturnType<typeof useSessionStore>) {
  return useCallback((msg: ChatMessage) => {
    const normalized = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: SESSION,
      timestamp: (msg.timestamp instanceof Date ? msg.timestamp : new Date()).toISOString(),
      provider: 'claude' as LLMProvider,
      kind: msg.type === 'error' ? 'error' : 'text',
      role: msg.type === 'user' ? 'user' : 'assistant',
      content: msg.content || '',
    } as unknown as NormalizedMessage;
    store.appendRealtime(SESSION, normalized);
  }, [store]);
}

/** The whole chat surface: one store, the real handler, the real composer. */
function setupChatSurface(sendMessage: (message: unknown) => boolean) {
  let listener: ((event: ServerEvent) => void) | null = null;
  const onSessionProcessing = vi.fn();

  const rendered = renderHook(() => {
    const store = useSessionStore();
    const streamingStatesRef = useRef(new Map());
    const lastSeqRef = useRef(new Map<string, number>());
    const statusCheckSentAtRef = useRef(new Map<string, number>());

    useChatRealtimeHandlers({
      subscribe: (fn) => {
        listener = fn;
        return () => { listener = null; };
      },
      provider: 'claude' as LLMProvider,
      selectedSession: { id: SESSION } as ProjectSession,
      currentSessionId: SESSION,
      setTokenBudget: vi.fn(),
      pendingPermissionRequests: [],
      setPendingPermissionRequests: vi.fn(),
      streamingStatesRef,
      lastSeqRef,
      statusCheckSentAtRef,
      onSessionProcessing,
      sessionStore: store,
    });

    const composer = useChatComposerState({
      selectedProject: {
        projectId: 'project-1',
        displayName: 'Demo',
        path: '/workspace/demo',
        fullPath: '/workspace/demo',
      } satisfies Project,
      selectedSession: { id: SESSION } satisfies ProjectSession,
      currentSessionId: SESSION,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: vi.fn(),
      resolvePermissionModeForProvider: (_p, m) => m as 'default',
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
      addMessage: useRealAddMessage(store),
      setIsUserScrolledUp: vi.fn(),
      setPendingPermissionRequests: vi.fn(),
    });

    return { store, composer };
  });

  return {
    rendered,
    onSessionProcessing,
    deliver: (event: ServerEvent) => act(() => { listener?.(event); }),
  };
}

async function loadTranscript(rendered: ReturnType<typeof setupChatSurface>['rendered']) {
  mockFetch.mockResolvedValueOnce(
    jsonResponse({
      messages: [
        serverRow('m1', 'user', 'do the thing', 0),
        serverRow('m2', 'assistant', 'working on it', 1000),
      ],
      total: 2,
      hasMore: false,
    }),
  );
  await act(async () => {
    await rendered.result.current.store.fetchFromServer(SESSION, { limit: 20, offset: 0 });
  });
}

async function pressSend(
  rendered: ReturnType<typeof setupChatSurface>['rendered'],
  text: string,
) {
  act(() => {
    rendered.result.current.composer.setInput(text);
  });
  await act(async () => {
    await rendered.result.current.composer.handleSubmit({
      preventDefault: vi.fn(),
    } as unknown as FormEvent<HTMLFormElement>);
  });
}

const transcriptContents = (rendered: ReturnType<typeof setupChatSurface>['rendered']) =>
  rendered.result.current.store.getSlot(SESSION).merged.map((m) => m.content);

beforeEach(() => {
  mockFetch.mockReset();
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('clicking Resume then sending a message (#450)', () => {
  it('leaves the session healthy after the chat_resumed ack', async () => {
    const { rendered, deliver } = setupChatSurface(() => true);
    await loadTranscript(rendered);

    // Step 2: the server's answer to `chat.resume`, verbatim from
    // chat-websocket.service.ts:656. No `id`.
    deliver({
      kind: 'chat_resumed',
      sessionId: SESSION,
      resumed: 1,
      timestamp: new Date(1_700_000_002_000).toISOString(),
    });

    expect(transcriptContents(rendered)).toEqual(['do the thing', 'working on it']);
  });

  it('shows the message, the spinner, and an empty composer on the next send', async () => {
    const sent: unknown[] = [];
    const { rendered, deliver, onSessionProcessing } = setupChatSurface((message) => {
      sent.push(message);
      return true;
    });
    await loadTranscript(rendered);

    deliver({ kind: 'chat_resumed', sessionId: SESSION, resumed: 1 });
    await pressSend(rendered, 'the message that vanished');

    // All three halves of the feedback the user lost.
    expect(transcriptContents(rendered)).toContain('the message that vanished');
    expect(onSessionProcessing).toHaveBeenCalled();
    expect(rendered.result.current.composer.input).toBe('');

    // And the send really did go out exactly once.
    expect(sent.filter((m) => (m as { type?: string })?.type === 'chat.send')).toHaveLength(1);
  });

  it('does not tempt the user into sending a second copy', async () => {
    const sent: unknown[] = [];
    const { rendered, deliver } = setupChatSurface((message) => {
      sent.push(message);
      return true;
    });
    await loadTranscript(rendered);

    deliver({ kind: 'chat_resumed', sessionId: SESSION, resumed: 1 });
    await pressSend(rendered, 'only once please');

    // The composer is empty, so the natural re-press has nothing to send. This
    // is the step that produced three identical runs from one intent.
    await act(async () => {
      await rendered.result.current.composer.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as FormEvent<HTMLFormElement>);
    });

    const chatSends = sent.filter((m) => (m as { type?: string })?.type === 'chat.send');
    expect(chatSends).toHaveLength(1);
  });

  it('keeps the session live for the assistant reply that follows', async () => {
    const { rendered, deliver } = setupChatSurface(() => true);
    await loadTranscript(rendered);

    deliver({ kind: 'chat_resumed', sessionId: SESSION, resumed: 1 });
    await pressSend(rendered, 'still working?');

    // The run's reply comes back over the same socket. A wedged slot swallowed
    // it, which is the "chat stuck until I reopen the app" half of #389.
    deliver({
      kind: 'text',
      id: 'srv_reply',
      sessionId: SESSION,
      role: 'assistant',
      content: 'yes, still here',
      provider: 'claude',
      timestamp: new Date(1_700_000_005_000).toISOString(),
    });

    expect(transcriptContents(rendered)).toContain('yes, still here');
  });
});
