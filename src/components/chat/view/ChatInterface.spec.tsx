import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatInterfaceProps } from '../types/types';

/*
 * ChatInterface.tsx is a pure composition/wiring component: it calls five
 * chat hooks, derives a handful of values from their outputs, and threads
 * everything into three child components. There is no independent
 * "business logic" worth unit-testing beyond the wiring itself, so every
 * hook and child component is mocked here (house style — see
 * ChatMessagesPane.spec.tsx) and the tests assert:
 *
 *   1. The two top-level render branches (no project selected vs. full UI).
 *   2. Values *derived* in this component (hasActivityIndicator,
 *      activeSessionId, placeholder text, permission context value) are
 *      computed correctly and reach the children that need them.
 *   3. Callbacks *defined* in this component (handleSessionEstablished,
 *      handleWebSocketReconnect, the global Escape-key abort handler, the
 *      scroll-to-bottom button, the attached-image removal callback) do the
 *      right thing when invoked, including their real conditional branches.
 */

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(() => vi.fn()),
  useChatProviderStateReturn: {} as Record<string, unknown>,
  useChatSessionStateReturn: {} as Record<string, unknown>,
  useChatComposerStateReturn: {} as Record<string, unknown>,
  useChatComposerStateArgs: [] as unknown[],
  useChatRealtimeHandlersArgs: [] as unknown[],
  useInterruptedResumeArgs: [] as unknown[],
  useInterruptedResumeReturn: { interrupted: false, resume: vi.fn() },
  sessionStore: {
    refreshFromServer: vi.fn(async () => {}),
    getSessionSlot: vi.fn(() => undefined),
  },
  clearStreamingStates: vi.fn(),
  retryPendingSends: vi.fn(),
  readPendingSends: vi.fn(() => [] as unknown[]),
  writePendingSends: vi.fn(),
  sendSubscribeBatch: vi.fn(),
}));

vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: mocks.subscribe }),
}));

vi.mock('../hooks/useChatProviderState', () => ({
  useChatProviderState: vi.fn(() => mocks.useChatProviderStateReturn),
}));

vi.mock('../hooks/useChatSessionState', () => ({
  useChatSessionState: vi.fn(() => mocks.useChatSessionStateReturn),
}));

vi.mock('../hooks/useChatComposerState', () => ({
  useChatComposerState: vi.fn((args: unknown) => {
    mocks.useChatComposerStateArgs.push(args);
    return mocks.useChatComposerStateReturn;
  }),
}));

vi.mock('../hooks/useChatRealtimeHandlers', () => ({
  useChatRealtimeHandlers: vi.fn((args: unknown) => {
    mocks.useChatRealtimeHandlersArgs.push(args);
  }),
  clearStreamingStates: mocks.clearStreamingStates,
}));

vi.mock('../hooks/useInterruptedResume', () => ({
  useInterruptedResume: vi.fn((sessionId: string | null) => {
    mocks.useInterruptedResumeArgs.push(sessionId);
    return mocks.useInterruptedResumeReturn;
  }),
}));

vi.mock('../../../stores/useSessionStore', () => ({
  useSessionStore: () => mocks.sessionStore,
}));

vi.mock('../utils/pendingSendRetry', () => ({
  retryPendingSends: mocks.retryPendingSends,
}));

vi.mock('../utils/pendingSends', () => ({
  readPendingSends: mocks.readPendingSends,
  writePendingSends: mocks.writePendingSends,
}));

vi.mock('../utils/subscribeTargets', () => ({
  sendSubscribeBatch: mocks.sendSubscribeBatch,
}));

vi.mock('./subcomponents/ChatMessagesPane', () => ({
  default: (props: Record<string, unknown>) => (
    <div
      data-testid="messages-pane"
      data-has-activity={String(props.hasActivityIndicator)}
      data-provider={String(props.provider)}
      data-current-session-id={String(props.currentSessionId)}
      onClick={() => (props.setProvider as (p: string) => void)('codex')}
    />
  ),
}));

vi.mock('./subcomponents/ChatComposer', () => ({
  default: (props: Record<string, unknown>) => (
    <div
      data-testid="composer"
      data-placeholder={String(props.placeholder)}
      data-conversation-started={String(props.conversationStarted)}
      onClick={() => (props.onRemoveImage as (i: number) => void)(1)}
    />
  ),
}));

vi.mock('./subcomponents/CommandResultModal', () => ({
  default: (props: Record<string, unknown>) => (
    <div
      data-testid="command-modal"
      data-current-session-id={String(props.currentSessionId)}
    />
  ),
}));

vi.mock('./subcomponents/InterruptedRunBanner', () => ({
  InterruptedRunBanner: (props: Record<string, unknown>) => (
    <div
      data-testid="interrupted-banner"
      data-show={String(props.show)}
      onClick={props.onResume as () => void}
    />
  ),
}));

import ChatInterface from './ChatInterface';

function baseProviderState(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'claude',
    setProvider: vi.fn(),
    claudeModel: 'sonnet',
    setClaudeModel: vi.fn(),
    codexModel: 'gpt',
    setCodexModel: vi.fn(),
    antigravityModel: 'gemini',
    setAntigravityModel: vi.fn(),
    currentProviderEffort: 'medium',
    currentProviderEffortOptions: ['low', 'medium', 'high'],
    permissionMode: 'default',
    pendingPermissionRequests: [],
    setPendingPermissionRequests: vi.fn(),
    cyclePermissionMode: vi.fn(),
    providerModelCatalog: {},
    providerModelCacheCatalog: {},
    providerModelsLoading: false,
    providerModelsRefreshing: false,
    hardRefreshProviderModels: vi.fn(),
    selectProviderModel: vi.fn(),
    setStoredProviderEffort: vi.fn(),
    resolvePermissionModeForProvider: vi.fn(),
    ...overrides,
  };
}

function baseSessionState(overrides: Record<string, unknown> = {}) {
  return {
    chatMessages: [],
    addMessage: vi.fn(),
    sessionActivity: null,
    isProcessing: false,
    canAbortSession: false,
    currentSessionId: 'sess-1',
    setCurrentSessionId: vi.fn(),
    isLoadingSessionMessages: false,
    sessionLoadFailed: false,
    retryLoadSession: vi.fn(),
    isLoadingMoreMessages: false,
    isUserScrolledUp: false,
    setIsUserScrolledUp: vi.fn(),
    tokenBudget: null,
    setTokenBudget: vi.fn(),
    visibleMessageCount: 50,
    visibleMessages: [],
    allMessagesLoaded: true,
    createDiff: undefined,
    scrollContainerRef: { current: null },
    scrollToBottom: vi.fn(),
    scrollToBottomAndReset: vi.fn(),
    handleScroll: vi.fn(),
    ...overrides,
  };
}

function baseComposerState(overrides: Record<string, unknown> = {}) {
  return {
    input: '',
    textareaRef: { current: null },
    inputHighlightRef: { current: null },
    isTextareaExpanded: false,
    filteredCommands: [],
    frequentCommands: [],
    commandQuery: '',
    showCommandMenu: false,
    selectedCommandIndex: -1,
    resetCommandMenuState: vi.fn(),
    handleCommandSelect: vi.fn(),
    handleToggleCommandMenu: vi.fn(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: -1,
    renderInputWithMentions: vi.fn(),
    selectFile: vi.fn(),
    attachedImages: ['a', 'b', 'c'],
    setAttachedImages: vi.fn(),
    uploadingImages: [],
    imageErrors: [],
    getRootProps: vi.fn(() => ({})),
    getInputProps: vi.fn(() => ({})),
    isDragActive: false,
    openImagePicker: vi.fn(),
    handleSubmit: vi.fn(),
    queuedDrafts: [],
    editQueuedDraft: vi.fn(),
    deleteQueuedDraft: vi.fn(),
    handleVoiceTranscript: vi.fn(),
    handleInputChange: vi.fn(),
    handleKeyDown: vi.fn(),
    handlePaste: vi.fn(),
    handleTextareaClick: vi.fn(),
    handleTextareaInput: vi.fn(),
    syncInputOverlayScroll: vi.fn(),
    handleClearInput: vi.fn(),
    handleAbortSession: vi.fn(),
    handlePermissionDecision: vi.fn(),
    handleGrantToolPermission: vi.fn(() => ({ success: true })),
    handleInputFocusChange: vi.fn(),
    isInputFocused: false,
    // Non-null by default: the modal is now gated on this payload (WP7 —
    // demand-loaded like every other rarely-used surface), so most tests here
    // exercise the "open" branch. The gate itself is covered separately below.
    commandModalPayload: { kind: 'help', data: {} } as unknown as Record<string, unknown>,
    closeCommandModal: vi.fn(),
    showCostModal: vi.fn(),
    ...overrides,
  };
}

const baseProps: ChatInterfaceProps = {
  selectedProject: { projectId: 'p1', displayName: 'proj', fullPath: '/tmp/proj' } as unknown as ChatInterfaceProps['selectedProject'],
  selectedSession: { id: 'sess-1' } as unknown as ChatInterfaceProps['selectedSession'],
  ws: null,
  sendMessage: vi.fn(() => true),
  onInputFocusChange: vi.fn(),
  onSessionProcessing: vi.fn(),
  onSessionIdle: vi.fn(),
  processingSessions: new Map(),
  onNavigateToSession: vi.fn(),
  onSessionEstablished: vi.fn(),
  onShowSettings: vi.fn(),
  showRawParameters: false,
  showThinking: false,
  sendByCtrlEnter: false,
  isMobile: false,
  externalMessageUpdate: 0,
  newSessionTrigger: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useChatProviderStateReturn = baseProviderState();
  mocks.useChatSessionStateReturn = baseSessionState();
  mocks.useChatComposerStateReturn = baseComposerState();
  mocks.useChatComposerStateArgs = [];
  mocks.useChatRealtimeHandlersArgs = [];
  mocks.useInterruptedResumeArgs = [];
  mocks.useInterruptedResumeReturn = { interrupted: false, resume: vi.fn() };
  mocks.subscribe.mockReturnValue(vi.fn());
  mocks.sessionStore.refreshFromServer.mockResolvedValue(undefined);
  mocks.sessionStore.getSessionSlot.mockReturnValue(undefined);
  mocks.readPendingSends.mockReturnValue([]);
});

afterEach(() => {
  cleanup();
});

describe('ChatInterface — no project selected', () => {
  it('renders the provider-aware empty state for claude', () => {
    mocks.useChatProviderStateReturn = baseProviderState({ provider: 'claude' });
    render(<ChatInterface {...baseProps} selectedProject={null} />);
    expect(
      screen.getByText('Select a project to start chatting with Claude'),
    ).toBeTruthy();
  });

  it('renders the provider-aware empty state for codex', () => {
    mocks.useChatProviderStateReturn = baseProviderState({ provider: 'codex' });
    render(<ChatInterface {...baseProps} selectedProject={null} />);
    expect(
      screen.getByText('Select a project to start chatting with Codex'),
    ).toBeTruthy();
  });

  it('renders the provider-aware empty state for antigravity', () => {
    mocks.useChatProviderStateReturn = baseProviderState({ provider: 'antigravity' });
    render(<ChatInterface {...baseProps} selectedProject={null} />);
    expect(
      screen.getByText('Select a project to start chatting with Antigravity'),
    ).toBeTruthy();
  });

  it('does not render the composer/messages pane when no project is selected', () => {
    render(<ChatInterface {...baseProps} selectedProject={null} />);
    expect(screen.queryByTestId('messages-pane')).toBeNull();
    expect(screen.queryByTestId('composer')).toBeNull();
  });
});

describe('ChatInterface — full UI', () => {
  it('renders the messages pane, composer, and command modal', async () => {
    render(<ChatInterface {...baseProps} />);
    expect(screen.getByTestId('messages-pane')).toBeTruthy();
    expect(screen.getByTestId('composer')).toBeTruthy();
    // Demand-loaded (WP7): resolves after the dynamic import's chunk lands,
    // even mocked, so this is the one assertion in the suite that awaits.
    expect(await screen.findByTestId('command-modal')).toBeTruthy();
  });

  it('does not mount the command modal chunk when there is no command payload', () => {
    mocks.useChatComposerStateReturn = baseComposerState({ commandModalPayload: null });
    render(<ChatInterface {...baseProps} />);
    expect(screen.queryByTestId('command-modal')).toBeNull();
  });

  it('computes hasActivityIndicator true when there is activity and no pending permission requests', () => {
    mocks.useChatSessionStateReturn = baseSessionState({ sessionActivity: { kind: 'thinking' } });
    mocks.useChatProviderStateReturn = baseProviderState({ pendingPermissionRequests: [] });
    render(<ChatInterface {...baseProps} />);
    expect(screen.getByTestId('messages-pane').getAttribute('data-has-activity')).toBe('true');
  });

  it('computes hasActivityIndicator false when there are pending permission requests', () => {
    mocks.useChatSessionStateReturn = baseSessionState({ sessionActivity: { kind: 'thinking' } });
    mocks.useChatProviderStateReturn = baseProviderState({
      pendingPermissionRequests: [{ id: '1' }],
    });
    render(<ChatInterface {...baseProps} />);
    expect(screen.getByTestId('messages-pane').getAttribute('data-has-activity')).toBe('false');
  });

  it('computes hasActivityIndicator false when there is no session activity', () => {
    mocks.useChatSessionStateReturn = baseSessionState({ sessionActivity: null });
    render(<ChatInterface {...baseProps} />);
    expect(screen.getByTestId('messages-pane').getAttribute('data-has-activity')).toBe('false');
  });

  it('renders the localized input placeholder', () => {
    mocks.useChatProviderStateReturn = baseProviderState({ provider: 'antigravity' });
    render(<ChatInterface {...baseProps} />);
    expect(screen.getByTestId('composer').getAttribute('data-placeholder')).toBe(
      'Type / for commands, @ for files…',
    );
  });

  it('marks the conversation as started once there are chat messages', () => {
    mocks.useChatSessionStateReturn = baseSessionState({
      chatMessages: [{ id: 'm1', type: 'user', content: 'hi', timestamp: new Date().toISOString() }],
    });
    render(<ChatInterface {...baseProps} />);
    expect(screen.getByTestId('composer').getAttribute('data-conversation-started')).toBe('true');
  });

  it('passes currentSessionId through to the messages pane and command modal', async () => {
    mocks.useChatSessionStateReturn = baseSessionState({ currentSessionId: 'sess-99' });
    render(<ChatInterface {...baseProps} />);
    expect(screen.getByTestId('messages-pane').getAttribute('data-current-session-id')).toBe('sess-99');
    expect((await screen.findByTestId('command-modal')).getAttribute('data-current-session-id')).toBe('sess-99');
  });

  it('falls back to the selected session id for the command modal when no current session id is set', async () => {
    mocks.useChatSessionStateReturn = baseSessionState({ currentSessionId: null });
    render(<ChatInterface {...baseProps} selectedSession={{ id: 'fallback-sess' } as never} />);
    expect((await screen.findByTestId('command-modal')).getAttribute('data-current-session-id')).toBe('fallback-sess');
  });

  it('does not show the scroll-to-bottom button when the user has not scrolled up', () => {
    mocks.useChatSessionStateReturn = baseSessionState({
      isUserScrolledUp: false,
      chatMessages: [{ id: 'm1', type: 'user', content: 'hi', timestamp: new Date().toISOString() }],
    });
    render(<ChatInterface {...baseProps} />);
    expect(screen.queryByLabelText('Scroll to bottom')).toBeNull();
  });

  it('does not show the scroll-to-bottom button when there are no messages, even if scrolled up', () => {
    mocks.useChatSessionStateReturn = baseSessionState({ isUserScrolledUp: true, chatMessages: [] });
    render(<ChatInterface {...baseProps} />);
    expect(screen.queryByLabelText('Scroll to bottom')).toBeNull();
  });

  it('shows the scroll-to-bottom button and calls scrollToBottomAndReset when clicked', () => {
    const scrollToBottomAndReset = vi.fn();
    mocks.useChatSessionStateReturn = baseSessionState({
      isUserScrolledUp: true,
      chatMessages: [{ id: 'm1', type: 'user', content: 'hi', timestamp: new Date().toISOString() }],
      scrollToBottomAndReset,
    });
    render(<ChatInterface {...baseProps} />);
    const button = screen.getByLabelText('Scroll to bottom');
    fireEvent.click(button);
    expect(scrollToBottomAndReset).toHaveBeenCalledTimes(1);
  });

  it('wraps setProvider with a Provider cast when handed to the messages pane', () => {
    const setProvider = vi.fn();
    mocks.useChatProviderStateReturn = baseProviderState({ setProvider });
    render(<ChatInterface {...baseProps} />);
    fireEvent.click(screen.getByTestId('messages-pane'));
    expect(setProvider).toHaveBeenCalledWith('codex');
  });

  it('removes the correct image by index via onRemoveImage', () => {
    const setAttachedImages = vi.fn();
    mocks.useChatComposerStateReturn = baseComposerState({
      attachedImages: ['a', 'b', 'c'],
      setAttachedImages,
    });
    render(<ChatInterface {...baseProps} />);
    fireEvent.click(screen.getByTestId('composer'));
    expect(setAttachedImages).toHaveBeenCalledTimes(1);
    const updater = setAttachedImages.mock.calls[0][0] as (prev: string[]) => string[];
    expect(updater(['a', 'b', 'c'])).toEqual(['a', 'c']);
  });
});

describe('ChatInterface — handleSessionEstablished wiring', () => {
  it('sets the current session id and forwards to the parent callbacks', () => {
    const setCurrentSessionId = vi.fn();
    const onSessionEstablished = vi.fn();
    const onNavigateToSession = vi.fn();
    mocks.useChatSessionStateReturn = baseSessionState({ setCurrentSessionId });
    render(
      <ChatInterface
        {...baseProps}
        onSessionEstablished={onSessionEstablished}
        onNavigateToSession={onNavigateToSession}
      />,
    );

    const composerArgs = mocks.useChatComposerStateArgs[0] as {
      onSessionEstablished: (id: string, ctx: unknown) => void;
    };
    composerArgs.onSessionEstablished('new-sess', { provider: 'claude' });

    expect(setCurrentSessionId).toHaveBeenCalledWith('new-sess');
    expect(onSessionEstablished).toHaveBeenCalledWith('new-sess', { provider: 'claude' });
    expect(onNavigateToSession).toHaveBeenCalledWith('new-sess');
  });

  it('tolerates missing onSessionEstablished/onNavigateToSession callbacks', () => {
    const setCurrentSessionId = vi.fn();
    mocks.useChatSessionStateReturn = baseSessionState({ setCurrentSessionId });
    render(
      <ChatInterface
        {...baseProps}
        onSessionEstablished={undefined}
        onNavigateToSession={undefined}
      />,
    );

    const composerArgs = mocks.useChatComposerStateArgs[0] as {
      onSessionEstablished: (id: string, ctx: unknown) => void;
    };
    expect(() => composerArgs.onSessionEstablished('new-sess', {})).not.toThrow();
    expect(setCurrentSessionId).toHaveBeenCalledWith('new-sess');
  });
});

describe('ChatInterface — handleWebSocketReconnect wiring', () => {
  it('refreshes the transcript and retries pending sends when a project+session are open and sends are pending', async () => {
    mocks.readPendingSends.mockReturnValue([{ id: 'p1' } as never]);
    mocks.sessionStore.getSessionSlot.mockReturnValue({ serverMessages: ['m1'] } as never);
    render(<ChatInterface {...baseProps} />);

    const realtimeArgs = mocks.useChatRealtimeHandlersArgs[0] as {
      onWebSocketReconnect: () => Promise<void>;
    };
    await realtimeArgs.onWebSocketReconnect();

    expect(mocks.sessionStore.refreshFromServer).toHaveBeenCalledWith('sess-1');
    expect(mocks.readPendingSends).toHaveBeenCalledWith('sess-1');
    expect(mocks.retryPendingSends).toHaveBeenCalledTimes(1);
    const retryArgs = mocks.retryPendingSends.mock.calls[0][0] as Record<string, unknown>;
    expect(retryArgs.sessionId).toBe('sess-1');
    expect(retryArgs.serverMessages).toEqual(['m1']);
    expect(retryArgs.transcriptComplete).toBe(true);
    expect(mocks.sendSubscribeBatch).toHaveBeenCalledTimes(1);
  });

  it('skips the transcript refresh and retry when there is no selected session', async () => {
    render(<ChatInterface {...baseProps} selectedSession={null} />);

    const realtimeArgs = mocks.useChatRealtimeHandlersArgs[0] as {
      onWebSocketReconnect: () => Promise<void>;
    };
    await realtimeArgs.onWebSocketReconnect();

    expect(mocks.sessionStore.refreshFromServer).not.toHaveBeenCalled();
    expect(mocks.retryPendingSends).not.toHaveBeenCalled();
    // Reconnect still re-subscribes any background runs even with no viewed session (#204).
    expect(mocks.sendSubscribeBatch).toHaveBeenCalledTimes(1);
  });

  it('skips the retry call when there are no pending sends', async () => {
    mocks.readPendingSends.mockReturnValue([]);
    render(<ChatInterface {...baseProps} />);

    const realtimeArgs = mocks.useChatRealtimeHandlersArgs[0] as {
      onWebSocketReconnect: () => Promise<void>;
    };
    await realtimeArgs.onWebSocketReconnect();

    expect(mocks.sessionStore.refreshFromServer).toHaveBeenCalled();
    expect(mocks.retryPendingSends).not.toHaveBeenCalled();
  });

  it('passes the running-session ids and lastSeq lookups through to sendSubscribeBatch', async () => {
    const processingSessions = new Map([['sess-2', {}], ['sess-3', {}]]) as never;
    render(<ChatInterface {...baseProps} processingSessions={processingSessions} />);

    const realtimeArgs = mocks.useChatRealtimeHandlersArgs[0] as {
      onWebSocketReconnect: () => Promise<void>;
    };
    await realtimeArgs.onWebSocketReconnect();

    const batchArgs = mocks.sendSubscribeBatch.mock.calls[0][0] as {
      selectedSessionId: string | null;
      runningSessionIds: IterableIterator<string>;
      lastSeqFor: (id: string) => number;
      markSubscribeSent: (id: string, at: number) => void;
      send: (message: unknown) => boolean;
    };
    expect(batchArgs.selectedSessionId).toBe('sess-1');
    expect([...batchArgs.runningSessionIds]).toEqual(['sess-2', 'sess-3']);
    expect(batchArgs.lastSeqFor('unknown-session')).toBe(0);
    expect(() => batchArgs.markSubscribeSent('sess-1', Date.now())).not.toThrow();
  });
});

describe('ChatInterface — global Escape-to-abort', () => {
  it('aborts the session on a plain Escape keydown when a session can be aborted', () => {
    const handleAbortSession = vi.fn();
    mocks.useChatSessionStateReturn = baseSessionState({ canAbortSession: true });
    mocks.useChatComposerStateReturn = baseComposerState({ handleAbortSession });
    render(<ChatInterface {...baseProps} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(handleAbortSession).toHaveBeenCalledTimes(1);
  });

  it('does not abort on Escape when canAbortSession is false', () => {
    const handleAbortSession = vi.fn();
    mocks.useChatSessionStateReturn = baseSessionState({ canAbortSession: false });
    mocks.useChatComposerStateReturn = baseComposerState({ handleAbortSession });
    render(<ChatInterface {...baseProps} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(handleAbortSession).not.toHaveBeenCalled();
  });

  it('ignores a repeated Escape keydown', () => {
    const handleAbortSession = vi.fn();
    mocks.useChatSessionStateReturn = baseSessionState({ canAbortSession: true });
    mocks.useChatComposerStateReturn = baseComposerState({ handleAbortSession });
    render(<ChatInterface {...baseProps} />);

    fireEvent.keyDown(document, { key: 'Escape', repeat: true });
    expect(handleAbortSession).not.toHaveBeenCalled();
  });

  it('ignores an already-handled (defaultPrevented) Escape keydown', () => {
    const handleAbortSession = vi.fn();
    mocks.useChatSessionStateReturn = baseSessionState({ canAbortSession: true });
    mocks.useChatComposerStateReturn = baseComposerState({ handleAbortSession });
    render(<ChatInterface {...baseProps} />);

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    event.preventDefault();
    document.dispatchEvent(event);
    expect(handleAbortSession).not.toHaveBeenCalled();
  });

  it('ignores non-Escape keys', () => {
    const handleAbortSession = vi.fn();
    mocks.useChatSessionStateReturn = baseSessionState({ canAbortSession: true });
    mocks.useChatComposerStateReturn = baseComposerState({ handleAbortSession });
    render(<ChatInterface {...baseProps} />);

    fireEvent.keyDown(document, { key: 'a' });
    expect(handleAbortSession).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount and stops reacting to Escape', () => {
    const handleAbortSession = vi.fn();
    mocks.useChatSessionStateReturn = baseSessionState({ canAbortSession: true });
    mocks.useChatComposerStateReturn = baseComposerState({ handleAbortSession });
    const { unmount } = render(<ChatInterface {...baseProps} />);
    unmount();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(handleAbortSession).not.toHaveBeenCalled();
  });

  it('does not attach a listener at all when canAbortSession starts false, then attaches after it flips true', () => {
    const handleAbortSession = vi.fn();
    mocks.useChatSessionStateReturn = baseSessionState({ canAbortSession: false });
    mocks.useChatComposerStateReturn = baseComposerState({ handleAbortSession });
    const { rerender } = render(<ChatInterface {...baseProps} externalMessageUpdate={0} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(handleAbortSession).not.toHaveBeenCalled();

    mocks.useChatSessionStateReturn = baseSessionState({ canAbortSession: true });
    // ChatInterface is wrapped in React.memo; bump a prop so the memoized
    // component actually re-renders and the effect re-evaluates.
    rerender(<ChatInterface {...baseProps} externalMessageUpdate={1} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(handleAbortSession).toHaveBeenCalledTimes(1);
  });
});

describe('ChatInterface — interrupted-run resume banner', () => {
  it('uses currentSessionId as the active session id when present', () => {
    mocks.useChatSessionStateReturn = baseSessionState({ currentSessionId: 'sess-current' });
    render(<ChatInterface {...baseProps} selectedSession={{ id: 'sess-selected' } as never} />);
    expect(mocks.useInterruptedResumeArgs[0]).toBe('sess-current');
  });

  it('falls back to the selected session id when there is no current session id yet', () => {
    mocks.useChatSessionStateReturn = baseSessionState({ currentSessionId: null });
    render(<ChatInterface {...baseProps} selectedSession={{ id: 'sess-selected' } as never} />);
    expect(mocks.useInterruptedResumeArgs[0]).toBe('sess-selected');
  });

  it('falls back to null when neither a current nor a selected session exists', () => {
    mocks.useChatSessionStateReturn = baseSessionState({ currentSessionId: null });
    render(<ChatInterface {...baseProps} selectedSession={null} />);
    expect(mocks.useInterruptedResumeArgs[0]).toBe(null);
  });

  it('shows the banner when interrupted and not currently processing, and resuming calls resume()', () => {
    const resume = vi.fn();
    mocks.useInterruptedResumeReturn = { interrupted: true, resume };
    mocks.useChatSessionStateReturn = baseSessionState({ isProcessing: false });
    render(<ChatInterface {...baseProps} />);

    const banner = screen.getByTestId('interrupted-banner');
    expect(banner.getAttribute('data-show')).toBe('true');
    fireEvent.click(banner);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('hides the banner once the session is processing again, even if still flagged interrupted', () => {
    mocks.useInterruptedResumeReturn = { interrupted: true, resume: vi.fn() };
    mocks.useChatSessionStateReturn = baseSessionState({ isProcessing: true });
    render(<ChatInterface {...baseProps} />);
    expect(screen.getByTestId('interrupted-banner').getAttribute('data-show')).toBe('false');
  });

  it('hides the banner when not interrupted', () => {
    mocks.useInterruptedResumeReturn = { interrupted: false, resume: vi.fn() };
    render(<ChatInterface {...baseProps} />);
    expect(screen.getByTestId('interrupted-banner').getAttribute('data-show')).toBe('false');
  });
});
