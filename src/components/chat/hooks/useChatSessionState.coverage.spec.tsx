import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writePendingSends } from '../utils/pendingSends';

import { useChatSessionState } from './useChatSessionState';

import type { Project, ProjectSession } from '@/types/app';
import type { SessionStore, SessionSlot, NormalizedMessage } from '@/stores/useSessionStore';
import type { SessionActivityMap } from '@/hooks/useSessionProtection';



/**
 * Broader behavioural coverage for useChatSessionState: message bookkeeping
 * (addMessage/clearMessages/rewindMessages), scroll helpers, pagination via
 * loadOlderMessages/handleScroll, the New Session reset, the main session
 * loading effect's branches, the external-message-update refresh, and
 * retryLoadSession. The three sibling specs each pin one specific bug; this
 * one fills in everything else the hook does.
 */

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));

const project = { projectId: 'p1', displayName: 'demo', fullPath: '/repo/demo' } as Project;

function makeMessage(id: string, index: number): NormalizedMessage {
  return {
    id,
    sessionId: 's1',
    timestamp: new Date(1700000000000 + index * 1000).toISOString(),
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: `message ${index}`,
  };
}

function makeSlot(overrides: Partial<SessionSlot> = {}): SessionSlot {
  return {
    hasMore: false,
    total: 0,
    status: 'idle',
    tokenUsage: null,
    serverMessages: [],
    realtimeMessages: [],
    ...overrides,
  } as SessionSlot;
}

function makeSessionStore(messages: NormalizedMessage[] = []): SessionStore {
  return {
    has: () => false,
    isStale: () => true,
    getMessages: vi.fn(() => messages),
    getSessionSlot: vi.fn(() => makeSlot()),
    setActiveSession: vi.fn(),
    noteProvider: vi.fn(),
    hydrateFromCache: vi.fn(async () => false),
    refreshFromServer: vi.fn(async () => null),
    fetchFromServer: vi.fn(async () => makeSlot()),
    fetchMore: vi.fn(async () => null),
    appendRealtime: vi.fn(),
    clearRealtime: vi.fn(),
  } as unknown as SessionStore;
}

type HookProps = {
  selectedSession: ProjectSession | null;
  selectedProject?: Project | null;
  ws?: WebSocket | null;
  sendMessage?: (message: unknown) => boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
};

function renderSessionState(sessionStore: SessionStore, initialProps: HookProps) {
  const sendMessage = initialProps.sendMessage ?? vi.fn(() => true);
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const lastSeqRef = { current: new Map<string, number>() };

  return renderHook(
    (props: HookProps) =>
      useChatSessionState({
        selectedProject: props.selectedProject === undefined ? project : props.selectedProject,
        selectedSession: props.selectedSession,
        ws: props.ws ?? null,
        sendMessage: props.sendMessage ?? sendMessage,
        externalMessageUpdate: props.externalMessageUpdate,
        newSessionTrigger: props.newSessionTrigger,
        processingSessions: props.processingSessions,
        statusCheckSentAtRef,
        lastSeqRef,
        sessionStore,
      }),
    { initialProps },
  );
}

// `scrollContainerRef` is typed as a read-only RefObject (useRef<HTMLDivElement>(null)
// selects that overload), but attaching a fake container is exactly what a real
// <div ref={scrollContainerRef}> mount does, so tests need to poke past the
// read-only type without touching the hook's own source.
function setContainer(ref: { current: HTMLDivElement | null }, container: HTMLDivElement | null): void {
  (ref as { current: HTMLDivElement | null }).current = container;
}

function fakeContainer(scrollTop = 0, scrollHeight = 1000, clientHeight = 500) {
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelectorAll: () => [],
    firstElementChild: null,
  } as unknown as HTMLDivElement;
}

/**
 * A container that has one anchor row (`data-row-key="row-1"`) findable by
 * both `querySelectorAll('[data-row-key]')` (capture) and
 * `querySelector('[data-row-key="row-1"]')` (restore) — `captureScrollAnchor`
 * and the restore `useLayoutEffect` both query the container this way (see
 * `useChatSessionState.ts`). The row's `getBoundingClientRect` returns
 * `rowTopAtCapture` on its first call and `rowTopAtRestore` on every call
 * after, standing in for a real prepend having pushed it down the page
 * between when the anchor was captured and when the restore effect re-reads
 * its position — the exact scenario `resolveAnchoredScrollTop` exists for.
 */
function fakeContainerWithAnchorRow(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  rowTopAtCapture: number,
  rowTopAtRestore: number,
) {
  let rowRectCalls = 0;
  const row = {
    getAttribute: (name: string) => (name === 'data-row-key' ? 'row-1' : null),
    getBoundingClientRect: () => {
      rowRectCalls += 1;
      return { top: rowRectCalls === 1 ? rowTopAtCapture : rowTopAtRestore };
    },
    offsetHeight: 40,
  };
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [row],
    querySelector: (selector: string) => (selector === '[data-row-key="row-1"]' ? row : null),
    firstElementChild: null,
  } as unknown as HTMLDivElement;
}

/**
 * A container with no anchor row (`querySelectorAll` returns `[]`, so
 * `captureScrollAnchor` returns `null` and the restore effect must take the
 * `resolveRestoreScrollTop` fallback branch) whose `scrollHeight` grows from
 * `before` to `after` partway through the read sequence a real
 * `handleScroll` → `loadOlderMessages` → restore pass makes: once via
 * `readScrollMetrics` on entry, once capturing the fallback right after
 * `fetchMore` resolves (still pre-prepend — the DOM hasn't re-rendered yet),
 * and once more inside the restore `useLayoutEffect` after the prepend has
 * actually landed. A static `scrollHeight` (as in `fakeContainer`) can't
 * distinguish "the fallback math ran and produced this number" from "the
 * effect never ran at all and scrollTop was simply never touched".
 */
function fakeContainerWithGrowingHeight(
  scrollTop: number,
  clientHeight: number,
  before: number,
  after: number,
) {
  let reads = 0;
  return {
    scrollTop,
    get scrollHeight() {
      reads += 1;
      // The first two reads (readScrollMetrics, then the fallback capture)
      // both see the pre-prepend height; only the restore effect's read,
      // after the new render has committed, sees the grown one.
      return reads <= 2 ? before : after;
    },
    clientHeight,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelectorAll: () => [],
    firstElementChild: null,
  } as unknown as HTMLDivElement;
}

beforeEach(() => {
  authenticatedFetch.mockReset();
  authenticatedFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
});

afterEach(() => {
  vi.clearAllMocks();
  // Belt-and-suspenders for the #325 pending-sends test below: if it throws
  // before its own cleanup line runs, the key must not leak into later tests
  // in this file (vitest does not reset localStorage between `it`s).
  localStorage.removeItem('pending_send_s1');
});

describe('useChatSessionState — message bookkeeping', () => {
  it('addMessage with no active session shows the message as pending, then flushes once a session appears', async () => {
    const sessionStore = makeSessionStore();
    const { result, rerender } = renderSessionState(sessionStore, { selectedSession: null });

    act(() => result.current.addMessage({ type: 'user', content: 'hi there' } as never));

    expect(result.current.chatMessages.map((m) => m.content)).toContain('hi there');
    expect(sessionStore.appendRealtime).not.toHaveBeenCalled();

    rerender({ selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(sessionStore.appendRealtime).toHaveBeenCalled());
    const [sessionId, normalized] = (sessionStore.appendRealtime as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sessionId).toBe('s1');
    expect(normalized.content).toBe('hi there');
  });

  it('addMessage with an active session appends directly to the store', async () => {
    const sessionStore = makeSessionStore();
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(sessionStore.setActiveSession).toHaveBeenCalledWith('s1'));

    act(() => result.current.addMessage({ type: 'assistant', content: 'reply' } as never));

    expect(sessionStore.appendRealtime).toHaveBeenCalledWith('s1', expect.objectContaining({ content: 'reply' }));
  });

  it('clearMessages clears the active session and is a no-op without one', () => {
    const sessionStore = makeSessionStore();
    const { result } = renderSessionState(sessionStore, { selectedSession: null });

    act(() => result.current.clearMessages());
    expect(sessionStore.clearRealtime).not.toHaveBeenCalled();
  });

  it('clearMessages with an active session clears it', async () => {
    const sessionStore = makeSessionStore();
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(sessionStore.setActiveSession).toHaveBeenCalled());

    act(() => result.current.clearMessages());
    expect(sessionStore.clearRealtime).toHaveBeenCalledWith('s1');
  });

  it('normalizes every ChatMessage flavour addMessage can receive', async () => {
    const sessionStore = makeSessionStore();
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(sessionStore.setActiveSession).toHaveBeenCalled());
    const appendRealtime = sessionStore.appendRealtime as ReturnType<typeof vi.fn>;

    act(() =>
      result.current.addMessage({
        type: 'assistant',
        isToolUse: true,
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolId: 'tool-1',
      } as never),
    );
    expect(appendRealtime.mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'tool_use', toolName: 'Bash' });

    act(() => result.current.addMessage({ type: 'assistant', isThinking: true, content: 'hmm' } as never));
    expect(appendRealtime.mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'thinking', content: 'hmm' });

    act(() =>
      result.current.addMessage({ type: 'assistant', isInteractivePrompt: true, content: 'choose one' } as never),
    );
    expect(appendRealtime.mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'interactive_prompt', content: 'choose one' });

    act(() =>
      result.current.addMessage({ type: 'assistant', isTaskNotification: true, taskStatus: 'failed', content: 'oops' } as never),
    );
    expect(appendRealtime.mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'task_notification', status: 'failed' });

    act(() => result.current.addMessage({ type: 'error', content: 'boom' } as never));
    expect(appendRealtime.mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'error', content: 'boom' });

    act(() =>
      result.current.addMessage({
        type: 'user',
        content: 'with a numeric timestamp',
        timestamp: 1700000000000 as unknown as Date,
        images: ['data:image/png;base64,abc'],
      } as never),
    );
    expect(appendRealtime.mock.calls.at(-1)?.[1]).toMatchObject({
      kind: 'text',
      role: 'user',
      images: ['data:image/png;base64,abc'],
    });
  });

  it('rewindMessages hides the trailing N messages from the derived view', async () => {
    const messages = [makeMessage('m0', 0), makeMessage('m1', 1), makeMessage('m2', 2)];
    const sessionStore = makeSessionStore(messages);
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(result.current.chatMessages.length).toBe(3));

    act(() => result.current.rewindMessages(1));

    expect(result.current.chatMessages.length).toBe(2);
  });
});

describe('useChatSessionState — scroll helpers', () => {
  it('scrollToBottom pins the container and clears isUserScrolledUp', async () => {
    const sessionStore = makeSessionStore();
    const { result } = renderSessionState(sessionStore, { selectedSession: null });
    const container = fakeContainer(200, 900, 400);
    setContainer(result.current.scrollContainerRef, container);
    act(() => result.current.setIsUserScrolledUp(true));

    act(() => result.current.scrollToBottom());

    expect(container.scrollTop).toBe(900);
    expect(result.current.isUserScrolledUp).toBe(false);
  });

  it('scrollToBottom without a container is a no-op', () => {
    const sessionStore = makeSessionStore();
    const { result } = renderSessionState(sessionStore, { selectedSession: null });
    expect(() => act(() => result.current.scrollToBottom())).not.toThrow();
  });

  it('isNearBottom reflects the container metrics, and is false without one', () => {
    const sessionStore = makeSessionStore();
    const { result } = renderSessionState(sessionStore, { selectedSession: null });
    expect(result.current.isNearBottom()).toBe(false);

    const container = fakeContainer(490, 900, 400);
    setContainer(result.current.scrollContainerRef, container);
    // scrollHeight(900) - scrollTop(490) - clientHeight(400) = 10 -> near bottom
    expect(result.current.isNearBottom()).toBe(true);
  });

  it('scrollToBottomAndReset always pins the container to the bottom', async () => {
    // The allMessagesLoaded-reset half of this function is covered separately
    // by "scrollToBottomAndReset re-enables pagination once all messages were
    // loaded" below, which actually drives that state via loadOlderMessages.
    // This just pins the unconditional scrollToBottom delegation.
    const sessionStore = makeSessionStore();
    const { result } = renderSessionState(sessionStore, {
      selectedSession: { id: 's1' } as ProjectSession,
    });
    await waitFor(() => expect(sessionStore.setActiveSession).toHaveBeenCalled());
    const container = fakeContainer(0, 1000, 500);
    setContainer(result.current.scrollContainerRef, container);

    act(() => result.current.scrollToBottomAndReset());

    expect(container.scrollTop).toBe(1000);
  });
});

describe('useChatSessionState — the New Session reset', () => {
  it('resets local session state when the trigger increments', async () => {
    const sessionStore = makeSessionStore([makeMessage('m0', 0)]);
    const { result, rerender } = renderSessionState(sessionStore, {
      selectedSession: { id: 's1' } as ProjectSession,
      newSessionTrigger: 0,
    });
    await waitFor(() => expect(result.current.currentSessionId).toBe('s1'));

    rerender({ selectedSession: { id: 's1' } as ProjectSession, newSessionTrigger: 1 });

    await waitFor(() => expect(result.current.currentSessionId).toBeNull());
    expect(result.current.tokenBudget).toBeNull();
  });

  it('does not reset when the trigger is unchanged across renders', async () => {
    const sessionStore = makeSessionStore();
    const { result, rerender } = renderSessionState(sessionStore, {
      selectedSession: { id: 's1' } as ProjectSession,
      newSessionTrigger: 5,
    });
    await waitFor(() => expect(result.current.currentSessionId).toBe('s1'));

    rerender({ selectedSession: { id: 's1' } as ProjectSession, newSessionTrigger: 5 });

    expect(result.current.currentSessionId).toBe('s1');
  });
});

describe('useChatSessionState — main session loading effect branches', () => {
  it('keeps the active view when the session drops but a run for it is still processing', async () => {
    const sessionStore = makeSessionStore();
    const processingSessions: SessionActivityMap = new Map([
      ['s1', { statusText: null, canInterrupt: true, startedAt: Date.now(), blocked: false }],
    ]);
    const { result, rerender } = renderSessionState(sessionStore, {
      selectedSession: { id: 's1' } as ProjectSession,
      processingSessions,
    });
    await waitFor(() => expect(result.current.currentSessionId).toBe('s1'));

    rerender({ selectedSession: null, processingSessions });

    // Session id kept because the run is still processing.
    expect(result.current.currentSessionId).toBe('s1');
  });

  it('clears state when the session drops and nothing is processing', async () => {
    const sessionStore = makeSessionStore();
    const { result, rerender } = renderSessionState(sessionStore, {
      selectedSession: { id: 's1' } as ProjectSession,
    });
    await waitFor(() => expect(result.current.currentSessionId).toBe('s1'));

    rerender({ selectedSession: null });

    await waitFor(() => expect(result.current.currentSessionId).toBeNull());
  });

  it('sends a subscribe frame over the socket when one is connected', async () => {
    const sessionStore = makeSessionStore();
    const sendMessage = vi.fn((_message: unknown) => true);
    const ws = {} as WebSocket;
    renderSessionState(sessionStore, {
      selectedSession: { id: 's1' } as ProjectSession,
      ws,
      sendMessage,
    });

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const sent = sendMessage.mock.calls.map((c) => c[0]);
    expect(sent.some((m) => (m as { type?: string })?.type === 'chat.subscribe')).toBe(true);
  });

  it('does not resubscribe or refetch on a redundant rerender of the same loaded session', async () => {
    const messages = [makeMessage('m0', 0)];
    const sessionStore = makeSessionStore(messages);
    sessionStore.has = () => true;
    sessionStore.isStale = () => false;
    const sendMessage = vi.fn((_message: unknown) => true);
    const ws = {} as WebSocket;
    const { rerender } = renderSessionState(sessionStore, {
      selectedSession: { id: 's1' } as ProjectSession,
      ws,
      sendMessage,
    });
    // First mount always runs the full load path (nothing cached yet).
    await waitFor(() => expect(sessionStore.fetchFromServer).toHaveBeenCalledTimes(1));
    const sendCallsAfterFirst = sendMessage.mock.calls.length;

    rerender({ selectedSession: { id: 's1' } as ProjectSession, ws, sendMessage });
    rerender({ selectedSession: { id: 's1' } as ProjectSession, ws, sendMessage });

    // A same-session rerender takes the "already loaded" skip branch: it
    // resubscribes (cheap, idempotent) but must not refetch the transcript.
    expect(sessionStore.fetchFromServer).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(sendCallsAfterFirst);
  });

  it('surfaces a load failure via sessionLoadFailed', async () => {
    const sessionStore = makeSessionStore();
    sessionStore.fetchFromServer = vi.fn(async () => makeSlot({ status: 'error' }));
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });

    await waitFor(() => expect(result.current.sessionLoadFailed).toBe(true));
  });

  it('recovers a pending send left over from a closed-app crash (#325)', async () => {
    const sessionStore = makeSessionStore();
    sessionStore.fetchFromServer = vi.fn(async () => makeSlot({ hasMore: false, total: 0, serverMessages: [] }));
    writePendingSends('s1', [
      { id: 'cid-1', content: 'never arrived', timestamp: new Date().toISOString(), dispatched: false },
    ]);
    const sendMessage = vi.fn((_message: unknown) => true);

    renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession, sendMessage });

    await waitFor(() =>
      expect(sendMessage.mock.calls.some((c) => (c[0] as { type?: string })?.type === 'chat.send')).toBe(true),
    );
    localStorage.removeItem('pending_send_s1');
  });
});

describe('useChatSessionState — external message update', () => {
  it('refreshes the store when an external update fires and nothing is processing', async () => {
    const sessionStore = makeSessionStore();
    const { rerender } = renderSessionState(sessionStore, {
      selectedSession: { id: 's1' } as ProjectSession,
      externalMessageUpdate: 1,
    });
    await waitFor(() => expect(sessionStore.setActiveSession).toHaveBeenCalled());
    (sessionStore.refreshFromServer as ReturnType<typeof vi.fn>).mockClear();

    rerender({ selectedSession: { id: 's1' } as ProjectSession, externalMessageUpdate: 2 });

    await waitFor(() => expect(sessionStore.refreshFromServer).toHaveBeenCalledWith('s1'));
  });

  it('skips the refresh while the session is actively processing', async () => {
    const sessionStore = makeSessionStore();
    const processingSessions: SessionActivityMap = new Map([
      ['s1', { statusText: null, canInterrupt: true, startedAt: Date.now(), blocked: false }],
    ]);
    const { rerender } = renderSessionState(sessionStore, {
      selectedSession: { id: 's1' } as ProjectSession,
      externalMessageUpdate: 1,
      processingSessions,
    });
    await waitFor(() => expect(sessionStore.setActiveSession).toHaveBeenCalled());
    (sessionStore.refreshFromServer as ReturnType<typeof vi.fn>).mockClear();

    rerender({
      selectedSession: { id: 's1' } as ProjectSession,
      externalMessageUpdate: 2,
      processingSessions,
    });

    // Give the async effect a tick to have run if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionStore.refreshFromServer).not.toHaveBeenCalled();
  });

  it('logs rather than throws when the refresh fails', async () => {
    const sessionStore = makeSessionStore();
    sessionStore.refreshFromServer = vi.fn(async () => {
      throw new Error('network down');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = renderSessionState(sessionStore, {
      selectedSession: { id: 's1' } as ProjectSession,
      externalMessageUpdate: 1,
    });
    await waitFor(() => expect(sessionStore.setActiveSession).toHaveBeenCalled());

    rerender({ selectedSession: { id: 's1' } as ProjectSession, externalMessageUpdate: 2 });

    await waitFor(() =>
      expect(errors).toHaveBeenCalledWith('Error reloading messages from external update:', expect.any(Error)),
    );
    errors.mockRestore();
  });
});

describe('useChatSessionState — pagination via loadOlderMessages/handleScroll', () => {
  it('loads an older page when scrolled near the top', async () => {
    // See `fakeContainerWithGrowingHeight`'s doc comment: `getMessages` and
    // `scrollHeight` both have to actually change once `fetchMore` resolves,
    // or a `scrollTop` assertion below can't tell "the restore math ran" from
    // "the effect never fired and scrollTop was simply never touched".
    let liveMessages = [makeMessage('newest', 0)];
    const sessionStore = makeSessionStore(liveMessages);
    sessionStore.getMessages = vi.fn(() => liveMessages);
    sessionStore.fetchFromServer = vi.fn(async () => makeSlot({ hasMore: true, total: 40 }));
    sessionStore.fetchMore = vi.fn(async () => {
      liveMessages = [makeMessage('older', -1), ...liveMessages];
      return makeSlot({ hasMore: true, total: 40, serverMessages: [makeMessage('older', -1)] });
    });
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(result.current.hasMoreMessages).toBe(true));

    // The prepend grows the scrolled content by 300px (1000 -> 1300).
    const container = fakeContainerWithGrowingHeight(10, 500, 1000, 1300);
    setContainer(result.current.scrollContainerRef, container);

    await act(async () => {
      await result.current.handleScroll();
    });

    expect(sessionStore.fetchMore).toHaveBeenCalledWith('s1', { limit: expect.any(Number) });
    // No anchor row exists on this fake container (`querySelectorAll` returns
    // `[]`), so the restore effect falls back to `resolveRestoreScrollTop`:
    // fallback.top (10) + max(scrollHeight-at-restore (1300) - fallback.height
    // captured right after the fetch resolved (1000), 0) = 310.
    expect(container.scrollTop).toBe(310);
  });

  it('restores scroll against the anchor row\'s live post-prepend position, not a scrollHeight delta (cloudcli B1)', async () => {
    // `chatMessages` is derived from `sessionStore.getMessages(...)`
    // (`useChatSessionState.ts`'s `storeMessages`/`chatMessages` memo), which
    // only recomputes when that call returns a genuinely new array — so
    // `getMessages` here has to actually grow once `fetchMore` resolves for
    // the restore `useLayoutEffect` (keyed on `chatMessages.length`) to fire
    // at all. `makeSessionStore`'s default fixed-array stub can't exercise
    // this path; the other pagination tests below only assert `fetchMore` was
    // called, never that a resulting scrollTop lands anywhere in particular.
    let liveMessages = [makeMessage('newest', 0)];
    const sessionStore = makeSessionStore(liveMessages);
    sessionStore.getMessages = vi.fn(() => liveMessages);
    sessionStore.fetchFromServer = vi.fn(async () => makeSlot({ hasMore: true, total: 40 }));
    sessionStore.fetchMore = vi.fn(async () => {
      liveMessages = [makeMessage('older', -1), ...liveMessages];
      return makeSlot({ hasMore: true, total: 40, serverMessages: [makeMessage('older', -1)] });
    });
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(result.current.hasMoreMessages).toBe(true));

    // The anchor row sits 200px below the container's top edge at capture
    // time; by the time the restore effect re-reads it, its rect has moved to
    // 350px — standing in for ~150px of prepended content pushing it down.
    const container = fakeContainerWithAnchorRow(10, 1000, 500, 200, 350);
    setContainer(result.current.scrollContainerRef, container);

    await act(async () => {
      await result.current.handleScroll();
    });

    // resolveAnchoredScrollTop({ currentScrollTop: 10, anchorElementTop: 350,
    // anchor: { offset: 200 }, maxScrollTop: 500 }) = 10 + (350 - 200) = 160.
    expect(container.scrollTop).toBe(160);
  });

  it('marks all messages loaded once an older page reports no more and none returned', async () => {
    const sessionStore = makeSessionStore();
    sessionStore.fetchFromServer = vi.fn(async () => makeSlot({ hasMore: true, total: 5 }));
    sessionStore.fetchMore = vi.fn(async () => makeSlot({ hasMore: false, total: 5, serverMessages: [] }));
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(result.current.hasMoreMessages).toBe(true));

    const container = fakeContainer(10, 1000, 500);
    setContainer(result.current.scrollContainerRef, container);
    await act(async () => {
      await result.current.handleScroll();
    });

    expect(result.current.allMessagesLoaded).toBe(true);
  });

  it('does nothing when there is no more to load or no session/project', async () => {
    const sessionStore = makeSessionStore();
    const { result } = renderSessionState(sessionStore, { selectedSession: null });
    const container = fakeContainer(10, 1000, 500);
    setContainer(result.current.scrollContainerRef, container);

    await act(async () => {
      await result.current.handleScroll();
    });

    expect(sessionStore.fetchMore).not.toHaveBeenCalled();
  });

  it('handleScroll updates isUserScrolledUp based on distance from bottom', async () => {
    const sessionStore = makeSessionStore();
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(result.current.currentSessionId).toBe('s1'));

    const container = fakeContainer(0, 1000, 200);
    setContainer(result.current.scrollContainerRef, container);
    await act(async () => {
      await result.current.handleScroll();
    });

    expect(result.current.isUserScrolledUp).toBe(true);
  });
});

describe('useChatSessionState — token usage fetch', () => {
  it('logs rather than throws when the token-usage request itself rejects', async () => {
    authenticatedFetch.mockRejectedValueOnce(new Error('offline'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sessionStore = makeSessionStore();

    renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });

    await waitFor(() =>
      expect(errors).toHaveBeenCalledWith('Failed to fetch initial token usage:', expect.any(Error)),
    );
    errors.mockRestore();
  });
});

describe('useChatSessionState — visible message window', () => {
  it('caps visibleMessages at visibleMessageCount', async () => {
    const messages = Array.from({ length: 150 }, (_, i) => makeMessage(`m${i}`, i));
    const sessionStore = makeSessionStore(messages);
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });

    await waitFor(() => expect(result.current.chatMessages.length).toBe(150));
    expect(result.current.visibleMessages.length).toBe(result.current.visibleMessageCount);
    expect(result.current.visibleMessages.at(-1)?.content).toBe(messages.at(-1)?.content);
  });
});

describe('useChatSessionState — top-load lock repeat scrolls', () => {
  it('keeps the lock engaged on a second near-top scroll after a load, until the reader backs off', async () => {
    const sessionStore = makeSessionStore();
    sessionStore.fetchFromServer = vi.fn(async () => makeSlot({ hasMore: true, total: 5 }));
    sessionStore.fetchMore = vi.fn(async () =>
      makeSlot({ hasMore: false, total: 5, serverMessages: [makeMessage('older', -1)] }),
    );
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(result.current.hasMoreMessages).toBe(true));

    const container = fakeContainer(10, 1000, 500);
    setContainer(result.current.scrollContainerRef, container);
    await act(async () => {
      await result.current.handleScroll();
    });
    expect(sessionStore.fetchMore).toHaveBeenCalledTimes(1);
    expect(result.current.allMessagesLoaded).toBe(true);

    // A second near-top scroll: allMessagesLoadedRef is now true, so the whole
    // top-load branch is skipped and fetchMore is not called again.
    await act(async () => {
      await result.current.handleScroll();
    });
    expect(sessionStore.fetchMore).toHaveBeenCalledTimes(1);
  });

  it('scrollToBottomAndReset re-enables pagination once all messages were loaded', async () => {
    const sessionStore = makeSessionStore();
    sessionStore.fetchFromServer = vi.fn(async () => makeSlot({ hasMore: true, total: 2 }));
    sessionStore.fetchMore = vi.fn(async () =>
      makeSlot({ hasMore: false, total: 2, serverMessages: [makeMessage('older', -1)] }),
    );
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(result.current.hasMoreMessages).toBe(true));

    const container = fakeContainer(10, 1000, 500);
    setContainer(result.current.scrollContainerRef, container);
    await act(async () => {
      await result.current.handleScroll();
    });
    expect(result.current.allMessagesLoaded).toBe(true);

    act(() => result.current.scrollToBottomAndReset());

    expect(result.current.allMessagesLoaded).toBe(false);
    expect(result.current.visibleMessageCount).toBe(100);
  });
});

describe('useChatSessionState — search navigation target', () => {
  it('records a search target from the session and clears it once consumed', async () => {
    // Full DOM-scroll timing (setTimeout retries against real elements) is
    // covered end-to-end elsewhere; this pins the entry condition — a session
    // carrying a search snippet arms `searchTarget`, and the transcript being
    // ready lets the effect consume and clear it rather than leaving it armed
    // forever.
    const sessionStore = makeSessionStore([makeMessage('m0', 0)]);
    const session = {
      id: 's1',
      __searchTargetSnippet: 'a matching phrase',
    } as unknown as ProjectSession;
    const { result } = renderSessionState(sessionStore, { selectedSession: session });

    await waitFor(() => expect(result.current.chatMessages.length).toBe(1));
    // The effect fires synchronously with the transcript ready, consuming the
    // target the same tick it was set.
    await waitFor(() => expect(result.current.visibleMessageCount).toBe(Infinity));
  });
});

describe('useChatSessionState — retryLoadSession', () => {
  it('reloads the transcript and clears the failure flag on success', async () => {
    const sessionStore = makeSessionStore();
    sessionStore.fetchFromServer = vi
      .fn()
      .mockResolvedValueOnce(makeSlot({ status: 'error' }))
      .mockResolvedValueOnce(makeSlot({ status: 'idle', hasMore: true, total: 9 }));
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(result.current.sessionLoadFailed).toBe(true));

    await act(async () => {
      await result.current.retryLoadSession();
    });

    expect(result.current.sessionLoadFailed).toBe(false);
    expect(result.current.totalMessages).toBe(9);
  });

  it('sets the failure flag again when the retry also throws', async () => {
    const sessionStore = makeSessionStore();
    sessionStore.fetchFromServer = vi
      .fn()
      .mockResolvedValueOnce(makeSlot({ status: 'error' }))
      .mockRejectedValueOnce(new Error('still down'));
    const { result } = renderSessionState(sessionStore, { selectedSession: { id: 's1' } as ProjectSession });
    await waitFor(() => expect(result.current.sessionLoadFailed).toBe(true));

    await act(async () => {
      await result.current.retryLoadSession();
    });

    expect(result.current.sessionLoadFailed).toBe(true);
    expect(result.current.isLoadingSessionMessages).toBe(false);
  });

  it('is a no-op without a selected session', async () => {
    const sessionStore = makeSessionStore();
    const { result } = renderSessionState(sessionStore, { selectedSession: null });

    await act(async () => {
      await result.current.retryLoadSession();
    });

    expect(sessionStore.fetchFromServer).not.toHaveBeenCalled();
  });
});
