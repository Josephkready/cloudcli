import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionIdle, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';
import { retryPendingSends } from '../utils/pendingSendRetry';
import { readPendingSends, writePendingSends } from '../utils/pendingSends';
import { sendSubscribeBatch } from '../utils/subscribeTargets';
import { stabilizeMessageIdentities } from '../utils/messageIdentity';
import { reconcileTokenBudget } from '../utils/tokenBudget';
import { resolveRestoreScrollTop, type ScrollRestoreState } from '../utils/scrollRestore';
import {
  isGestureActive,
  isNearBottom as metricsAreNearBottom,
  shouldFollowNewMessages,
  shouldResumeAutoFollow,
  shouldSuspendAutoFollow,
  type ScrollMetrics,
} from '../utils/autoFollow';

import { normalizedToChatMessages } from './useChatMessages';

const MESSAGES_PER_PAGE = 20;
const INITIAL_VISIBLE_MESSAGES = 100;

interface UseChatSessionStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /** Highest live seq observed per session; sent as `lastSeq` on subscribe. */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  sessionStore: SessionStore;
}

// Shape and placement arithmetic live in ./utils/scrollRestore so they can be
// unit-tested without a DOM.

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isInteractivePrompt) {
    return { ...base, kind: 'interactive_prompt', content: msg.content || '' } as NormalizedMessage;
  }
  if ((msg as any).isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: (msg as any).taskStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its images immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  externalMessageUpdate,
  newSessionTrigger,
  processingSessions,
  onSessionIdle,
  statusCheckSentAtRef,
  lastSeqRef,
  sessionStore,
}: UseChatSessionStateArgs) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  /**
   * The last history load for this session failed. Tracked separately from
   * "zero messages" because the two are not the same thing: a failure that
   * renders as empty looks to the user like the conversation was deleted.
   */
  const [sessionLoadFailed, setSessionLoadFailed] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wasNearTopRef = useRef(false);
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  const isLoadingSessionRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  /*
   * Auto-follow bookkeeping (#333).
   *
   * All refs rather than state on purpose: the scheduled follow has to read
   * these at the moment it fires, and a `useState` value captured in the
   * timer's closure is exactly the stale read that caused the jump.
   */
  const isUserScrolledUpRef = useRef(false);
  const pointerDownRef = useRef(false);
  const pointerDownAtRef = useRef(0);
  const autoFollowSuspendedRef = useRef(false);
  const autoFollowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTopRef = useRef(0);
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> AppContent -> MainContent -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, streaming/status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     */
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setViewHiddenCount(0);
    setSearchTarget(null);
    wasNearTopRef.current = false;
    searchScrollActiveRef.current = false;
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    pendingInitialScrollRef.current = true;
    lastLoadedSessionKeyRef.current = null;

    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    if (loadAllFinishedTimerRef.current) {
      clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = null;
    }
  }, [newSessionTrigger, onSessionIdle]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null;
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Tell the store which session we're viewing so it only re-renders for this one
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionId !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionId;
    sessionStore.setActiveSession(activeSessionId);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : [];

  // Reset viewHiddenCount when store messages change
  const prevStoreLenRef = useRef(0);
  if (storeMessages.length !== prevStoreLenRef.current) {
    prevStoreLenRef.current = storeMessages.length;
    if (viewHiddenCount > 0) setViewHiddenCount(0);
  }

  // Holds the previous render's derived messages so each stabilization pass can
  // reuse still-valid object refs. Updated after commit (never during render)
  // so the memo below stays pure; on render N it reads render N-1's array.
  const previousChatMessagesRef = useRef<ChatMessage[]>([]);

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages);
    let derived: ChatMessage[];
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      derived = [pendingUserMessage];
    } else if (viewHiddenCount > 0 && viewHiddenCount < all.length) {
      derived = all.slice(0, -viewHiddenCount);
    } else {
      derived = all;
    }
    // `normalizedToChatMessages` mints brand-new ChatMessage objects on every
    // store update, so an active run's per-delta `notify` would hand a fresh
    // identity to every message each streaming tick — defeating
    // `React.memo(MessageComponent)` and re-rendering the whole visible list
    // (choppy scrolling while an agent works). Reuse the previous render's
    // object refs for messages whose value is unchanged so only the message
    // that actually changed re-renders.
    return stabilizeMessageIdentities(previousChatMessagesRef.current, derived);
  }, [storeMessages, viewHiddenCount, pendingUserMessage]);

  useEffect(() => {
    previousChatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  /* ---------------------------------------------------------------- */
  /*  addMessage / clearMessages / rewindMessages                     */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  const clearMessages = useCallback(() => {
    if (!activeSessionId) return;
    sessionStore.clearRealtime(activeSessionId);
  }, [activeSessionId, sessionStore]);

  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);

  const readScrollMetrics = useCallback((container: HTMLDivElement): ScrollMetrics => ({
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
  }), []);

  /**
   * Reads the pointer gate through its expiry, so a touch sequence that never
   * delivered `touchend`/`touchcancel` cannot wedge auto-follow off for good.
   */
  const pointerIsActive = useCallback(() => isGestureActive({
    pointerDown: pointerDownRef.current,
    startedAt: pointerDownAtRef.current,
    now: Date.now(),
  }), []);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    // An *explicit* jump to the bottom — the button, or sending a message —
    // re-arms following: the reader has asked to be pinned there again. The
    // state is cleared here rather than left to the scroll event this write
    // provokes, so the button's own effect does not depend on that event
    // arriving (it never fires if the pane was already at the bottom).
    autoFollowSuspendedRef.current = false;
    isUserScrolledUpRef.current = false;
    setIsUserScrolledUp(false);
    container.scrollTop = container.scrollHeight;
    lastScrollTopRef.current = container.scrollTop;
  }, []);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    return metricsAreNearBottom(readScrollMetrics(container));
  }, [readScrollMetrics]);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

      isLoadingMoreRef.current = true;
      const previousScrollHeight = container.scrollHeight;
      const previousScrollTop = container.scrollTop;

      try {
        const slot = await sessionStore.fetchMore(selectedSession.id, {
          limit: MESSAGES_PER_PAGE,
        });
        if (!slot) return false;
        if (slot.serverMessages.length === 0) {
          if (!slot.hasMore) {
            setHasMoreMessages(false);
            allMessagesLoadedRef.current = true;
            setAllMessagesLoaded(true);
            if (loadAllOverlayTimerRef.current) {
              clearTimeout(loadAllOverlayTimerRef.current);
              loadAllOverlayTimerRef.current = null;
            }
            setShowLoadAllOverlay(false);
          }
          return false;
        }

        // Incremental page: hold the reader's place across the prepend.
        pendingScrollRestoreRef.current = {
          mode: 'preserve',
          height: previousScrollHeight,
          top: previousScrollTop,
        };
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        setVisibleMessageCount((prev) => prev + MESSAGES_PER_PAGE);
        if (!slot.hasMore) {
          allMessagesLoadedRef.current = true;
          setAllMessagesLoaded(true);
          if (loadAllOverlayTimerRef.current) {
            clearTimeout(loadAllOverlayTimerRef.current);
            loadAllOverlayTimerRef.current = null;
          }
          setShowLoadAllOverlay(false);
        }
        return true;
      } finally {
        isLoadingMoreRef.current = false;
      }
    },
    [hasMoreMessages, isLoadingMoreMessages, selectedProject, selectedSession, sessionStore],
  );

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const metrics = readScrollMetrics(container);
    const nearBottom = metricsAreNearBottom(metrics);
    setIsUserScrolledUp(!nearBottom);
    isUserScrolledUpRef.current = !nearBottom;

    // Auto-follow suspension is tracked separately from `isUserScrolledUp`
    // because the two answer different questions. `isUserScrolledUp` drives the
    // scroll-to-bottom button and wants a generous 50px band; following wants
    // to stop the instant the reader drags upward, even inside that band.
    if (shouldSuspendAutoFollow({
      previousScrollTop: lastScrollTopRef.current,
      metrics,
      pointerDown: pointerIsActive(),
    })) {
      autoFollowSuspendedRef.current = true;
    } else if (shouldResumeAutoFollow(metrics)) {
      autoFollowSuspendedRef.current = false;
    }
    lastScrollTopRef.current = metrics.scrollTop;

    const scrolledNearTop = container.scrollTop < 100;

    // "Load all" prompt: appear (with fade-in) when the user reaches the top
    if (scrolledNearTop && hasMoreMessages && !allMessagesLoadedRef.current) {
      if (!wasNearTopRef.current) {
        wasNearTopRef.current = true;
        if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);

        setShowLoadAllOverlay(true);
        loadAllOverlayTimerRef.current = setTimeout(() => {
          setShowLoadAllOverlay(false);
          loadAllOverlayTimerRef.current = null;
        }, 2500);
      }
    } else if (!scrolledNearTop) {
      wasNearTopRef.current = false;
    }

    if (!allMessagesLoadedRef.current) {
      if (!scrolledNearTop) { topLoadLockRef.current = false; return; }
      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) topLoadLockRef.current = false;
        return;
      }
      const didLoad = await loadOlderMessages(container);
      if (didLoad) topLoadLockRef.current = true;
    }
  }, [hasMoreMessages, loadOlderMessages, pointerIsActive, readScrollMetrics]);

  useLayoutEffect(() => {
    if (!pendingScrollRestoreRef.current || !scrollContainerRef.current) return;
    const restore = pendingScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    container.scrollTop = resolveRestoreScrollTop(restore, container.scrollHeight);
    pendingScrollRestoreRef.current = null;
  }, [chatMessages.length]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    if (!searchScrollActiveRef.current) {
      pendingInitialScrollRef.current = true;
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    }
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    wasNearTopRef.current = false;
    setIsUserScrolledUp(false);
    isUserScrolledUpRef.current = false;
    autoFollowSuspendedRef.current = false;
    pointerDownRef.current = false;
    lastScrollTopRef.current = 0;
    // Drop the outgoing session's messages so the first stabilization pass for
    // the new session starts clean instead of comparing across sessions.
    previousChatMessagesRef.current = [];
  }, [selectedProject?.projectId, selectedSession?.id]);

  // Initial scroll to bottom — robust to lazy content reflow.
  // The previous implementation fired one scrollToBottom() at +200ms and
  // cleared the pending flag. When markdown blocks, code highlighting, or
  // images finished rendering after that window, scrollHeight grew but
  // nothing re-anchored the viewport, leaving the chat tab visually
  // "scrolled way up" with the latest assistant message off-screen.
  //
  // This version re-scrolls every animation frame while scrollHeight is
  // still growing, capped at ~1s (60 frames) or 3 consecutive stable
  // frames. Cancels cleanly on session change via the pending flag.
  useEffect(() => {
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) return;
    if (chatMessages.length === 0) { pendingInitialScrollRef.current = false; return; }
    if (searchScrollActiveRef.current) { pendingInitialScrollRef.current = false; return; }

    const container = scrollContainerRef.current;
    let frame = 0;
    let lastHeight = 0;
    let stableCount = 0;
    let rafId = 0;

    const tick = () => {
      if (!pendingInitialScrollRef.current || !scrollContainerRef.current) return;
      // The loop re-pins the bottom every frame for up to a second. If the
      // reader starts scrolling inside that window it would fight them once
      // per frame, so a touch ends the landing early and hands the pane over.
      if (pointerIsActive()) {
        pendingInitialScrollRef.current = false;
        return;
      }
      container.scrollTop = container.scrollHeight;
      if (container.scrollHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = container.scrollHeight;
      }
      frame++;
      if (stableCount < 3 && frame < 60) {
        rafId = requestAnimationFrame(tick);
      } else {
        pendingInitialScrollRef.current = false;
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [chatMessages.length, isLoadingSessionMessages, scrollToBottom]);

  // Main session loading effect — store-based
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it.
      if (currentSessionId && processingSessionsRef.current?.has(currentSessionId)) {
        return;
      }

      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${selectedProject.projectId}`;

    const subscribeToSelectedSession = () => {
      if (!ws) {
        return;
      }

      // Subscribe the viewed session AND every other session the client believes
      // is running, batched into one frame. Re-attaching all running sessions
      // (not just the viewed one) keeps a background run's stream and terminal
      // `complete` flowing to this socket after a fresh connect/reconnect,
      // instead of stranding its writer on a stale socket (issue #204). The
      // running set is the shared processing map fed by the running-sessions
      // poll; per-session `lastSeq` bounds replay to what this client missed.
      sendSubscribeBatch({
        selectedSessionId,
        runningSessionIds: processingSessionsRef.current
          ? processingSessionsRef.current.keys()
          : [],
        lastSeqFor: (id) => lastSeqRef.current.get(id) ?? 0,
        now: Date.now(),
        markSubscribeSent: (id, at) => statusCheckSentAtRef.current.set(id, at),
        send: sendMessage,
      });
    };

    // Skip if already loaded and fresh
    if (lastLoadedSessionKeyRef.current === sessionKey && sessionStore.has(selectedSessionId) && !sessionStore.isStale(selectedSessionId)) {
      subscribeToSelectedSession();
      return;
    }

    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setViewHiddenCount(0);
    wasNearTopRef.current = false;
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    if (sessionChanged) {
      setTokenBudget(null);
    }

    setCurrentSessionId(selectedSessionId);

    // Subscribe to the session's live run (if any): the ack reconciles the
    // processing indicator, re-attaches a mid-flight stream to this socket,
    // and replays any live events missed since `lastSeq`. Recording the send
    // time lets the ack handler discard idle acks that a newer request has
    // since outdated.
    subscribeToSelectedSession();

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    setSessionLoadFailed(false);
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: MESSAGES_PER_PAGE,
      offset: 0,
    }).then(slot => {
      // `fetchFromServer` swallows its own errors and reports them on the slot,
      // so the rejection path below never fires for a failed fetch.
      setSessionLoadFailed(slot?.status === 'error');
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        // Server-sourced like the fetch above, so it lags indexing the same way
        // and gets the same reconciliation (#240).
        if (slot.tokenUsage) {
          setTokenBudget((current) =>
            reconcileTokenBudget(current, slot.tokenUsage as Record<string, unknown>),
          );
        }

        // A send can be lost while the app is CLOSED, not just while it is open
        // — that is the reported shape of #325 ("close the app and reopen it,
        // your message disappears"). The reconnect pass cannot cover that case,
        // so recovery also runs here, against the transcript just fetched:
        // anything the server never got is resent, anything it has is dropped.
        const pendingForSession = readPendingSends(selectedSessionId);
        if (pendingForSession.length > 0) {
          retryPendingSends({
            sessionId: selectedSessionId,
            serverMessages: slot.serverMessages,
            entries: pendingForSession,
            send: sendMessage,
            persist: (entries) => writePendingSends(selectedSessionId, entries),
            now: () => Date.now(),
            // This fetch is one page (`MESSAGES_PER_PAGE`, offset 0). When more
            // remain, the session's older messages — its opening prompt above
            // all — are not in `slot.serverMessages`, and their absence must not
            // be read as "the server never got it" (#347/#350).
            transcriptComplete: !slot.hasMore,
          });
        }
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      setSessionLoadFailed(true);
      setIsLoadingSessionMessages(false);
    });
  }, [
    selectedProject,
    selectedSession?.id,
    sendMessage,
    statusCheckSentAtRef,
    lastSeqRef,
    ws,
    sessionStore,
  ]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        if (!isProcessing) {
          await sessionStore.refreshFromServer(selectedSession.id);

          if (isNearBottom()) {
            setTimeout(() => scrollToBottom(), 200);
          }
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    isNearBottom,
    scrollToBottom,
    selectedProject,
    selectedSession,
    sessionStore,
    isProcessing,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  // Scroll to search target
  useEffect(() => {
    if (!searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);

    const scrollToTarget = async () => {
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
          try {
            // Load all messages into the store for search navigation
            const slot = await sessionStore.fetchFromServer(selectedSession.id, {
              limit: null,
              offset: 0,
            });
            if (slot) {
              setHasMoreMessages(false);
              setTotalMessages(slot.total);
              messagesOffsetRef.current = slot.total;
              setVisibleMessageCount(Infinity);
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch {
            // Fall through and scroll in current messages
          }
      }
      setVisibleMessageCount(Infinity);

      const findAndScroll = (retriesLeft: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;

        let targetElement: Element | null = null;

        if (target.snippet) {
          const cleanSnippet = target.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
          const searchPhrase = cleanSnippet.slice(0, 80).toLowerCase().trim();
          if (searchPhrase.length >= 10) {
            const messageElements = container.querySelectorAll('.chat-message');
            for (const el of messageElements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes(searchPhrase)) { targetElement = el; break; }
            }
          }
        }

        if (!targetElement && target.timestamp) {
          const targetDate = new Date(target.timestamp).getTime();
          const messageElements = container.querySelectorAll('[data-message-timestamp]');
          let closestDiff = Infinity;
          for (const el of messageElements) {
            const ts = el.getAttribute('data-message-timestamp');
            if (!ts) continue;
            const diff = Math.abs(new Date(ts).getTime() - targetDate);
            if (diff < closestDiff) { closestDiff = diff; targetElement = el; }
          }
        }

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement?.classList.remove('search-highlight-flash'), 4000);
          searchScrollActiveRef.current = false;
        } else if (retriesLeft > 0) {
          setTimeout(() => findAndScroll(retriesLeft - 1), 200);
        } else {
          searchScrollActiveRef.current = false;
        }
      };

      setTimeout(() => findAndScroll(15), 150);
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isLoadingSessionMessages, searchTarget]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    if (!selectedProject || !selectedSession?.id) {
      setTokenBudget(null);
      return;
    }
    const fetchInitialTokenUsage = async () => {
      try {
        // The backend resolves the provider from the indexed session row.
        const url = `/api/projects/${selectedProject.projectId}/sessions/${selectedSession.id}/token-usage`;
        const response = await authenticatedFetch(url);
        if (response.ok) {
          const serverBudget = (await response.json()) as Record<string, unknown> | null;
          // A brand-new session is created *by* the run, so this fetch always
          // lands after the run's live `token_budget` frame — and returns zeros
          // because the transcript has not been indexed yet. Reconciling instead
          // of assigning stops the stale value winning (#240).
          setTokenBudget((current) => reconcileTokenBudget(current, serverBudget));
        }
        // A failed lookup says nothing about usage, so it must not blank a
        // budget the live run already reported. The session-change reset above
        // is what clears a previous session's value.
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    fetchInitialTokenUsage();
  }, [selectedProject, selectedSession?.id]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  useEffect(() => {
    if (!scrollContainerRef.current || chatMessages.length === 0) return undefined;
    if (isLoadingMoreRef.current || isLoadingMoreMessages || pendingScrollRestoreRef.current) return undefined;
    if (searchScrollActiveRef.current) return undefined;

    if (isUserScrolledUp) {
      // Nothing to do. New messages are appended *below* the viewport, so a
      // reader who has scrolled away keeps their position for free — and the
      // one case that does move content above them, a load-more prepend, is
      // handled by `pendingScrollRestoreRef` and bailed on above.
      return undefined;
    }

    // Deferred one tick so the freshly appended message has been laid out and
    // `scrollHeight` includes it. That delay is also the race in #333: the
    // reader can start dragging before it elapses, so every condition is
    // re-read here, at fire time, instead of being captured above.
    if (autoFollowTimerRef.current) clearTimeout(autoFollowTimerRef.current);
    autoFollowTimerRef.current = setTimeout(() => {
      autoFollowTimerRef.current = null;
      const container = scrollContainerRef.current;
      if (!container) return;
      if (!shouldFollowNewMessages({
        pointerDown: pointerIsActive(),
        autoFollowSuspended: autoFollowSuspendedRef.current,
        userScrolledUp: isUserScrolledUpRef.current,
      })) return;
      container.scrollTop = container.scrollHeight;
      lastScrollTopRef.current = container.scrollTop;
    }, 50);

    return () => {
      if (autoFollowTimerRef.current) {
        clearTimeout(autoFollowTimerRef.current);
        autoFollowTimerRef.current = null;
      }
    };
  }, [chatMessages.length, isLoadingMoreMessages, isUserScrolledUp]);

  /*
   * Follow the *content*, not just the message count (#333).
   *
   * The effect above fires on `chatMessages.length`, which only changes when a
   * message is added. A long assistant answer is one message whose body grows
   * for as long as the run streams, so the pane stopped tracking it: the reader
   * watched a static view while thousands of pixels accumulated below, and then
   * the next message to land fired a follow that leapt the whole distance at
   * once — the "it jumps, maybe when message is finished streaming" half of the
   * report. Observing the content box turns that leap into continuous tracking.
   *
   * Same predicate as the scheduled follow, so this cannot fight the reader
   * either: a finger on the glass or a suspended follow stops it dead.
   */
  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = container?.firstElementChild;
    if (!container || !content) return undefined;
    if (typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(() => {
      // A pending prepend owns the scroll position — overriding it would undo
      // the "hold the reader's place across a load-more" placement. The initial
      // landing pass needs no such guard: it wants the bottom too, and it
      // already stands down for a touch.
      if (pendingScrollRestoreRef.current) return;
      if (isLoadingMoreRef.current || searchScrollActiveRef.current) return;
      if (!shouldFollowNewMessages({
        pointerDown: pointerIsActive(),
        autoFollowSuspended: autoFollowSuspendedRef.current,
        userScrolledUp: isUserScrolledUpRef.current,
      })) return;
      container.scrollTop = container.scrollHeight;
      lastScrollTopRef.current = container.scrollTop;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [currentSessionId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;

    /*
     * Touch state gates auto-follow (#333). Without it the only signal was
     * `scrollTop`, which lags a drag by a frame or more on iOS — long enough
     * for a scheduled follow to fire mid-gesture and yank the pane back down.
     * Passive listeners: these never call `preventDefault`, and saying so keeps
     * the scroll on the compositor.
     */
    const onPointerDown = () => {
      pointerDownRef.current = true;
      pointerDownAtRef.current = Date.now();
    };
    const onPointerUp = () => {
      pointerDownRef.current = false;
    };

    container.addEventListener('scroll', handleScroll);
    container.addEventListener('touchstart', onPointerDown, { passive: true });
    container.addEventListener('touchend', onPointerUp, { passive: true });
    container.addEventListener('touchcancel', onPointerUp, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('touchstart', onPointerDown);
      container.removeEventListener('touchend', onPointerUp);
      container.removeEventListener('touchcancel', onPointerUp);
    };
  }, [handleScroll]);

  // "Load all" overlay visibility is driven by scroll-to-top in handleScroll;
  // timers are cleared on session change via the reset effect above.

  const loadAllMessages = useCallback(async () => {
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);
    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }

    const container = scrollContainerRef.current;
    const previousScrollHeight = container ? container.scrollHeight : 0;
    const previousScrollTop = container ? container.scrollTop : 0;

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        limit: null,
        offset: 0,
      });

      if (currentSessionId !== requestSessionId) return;

      if (slot) {
        if (container) {
          // The user explicitly asked for the whole thread, so land them at its
          // beginning rather than pinning the message they were already on —
          // preserving here is what read as "it only scrolls up a little" (#317).
          pendingScrollRestoreRef.current = {
            mode: 'toStart',
            height: previousScrollHeight,
            top: previousScrollTop,
          };
        }

        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.total;
        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          loadAllFinishedTimerRef.current = null;
        }, 2500);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [selectedSession, selectedProject, isLoadingAllMessages, currentSessionId, sessionStore]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((prev) => prev + 100);
  }, []);

  /**
   * Re-runs the initial history fetch after a failure. A read failure is often
   * transient (the transcript is appended to while we read it), so an in-place
   * retry usually beats making the user reload the page.
   */
  const retryLoadSession = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId) return;

    setIsLoadingSessionMessages(true);
    setSessionLoadFailed(false);
    try {
      const slot = await sessionStore.fetchFromServer(sessionId, {
        limit: MESSAGES_PER_PAGE,
        offset: 0,
      });
      setSessionLoadFailed(slot?.status === 'error');
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
      }
    } catch {
      setSessionLoadFailed(true);
    } finally {
      setIsLoadingSessionMessages(false);
    }
  }, [selectedSession?.id, sessionStore]);

  return {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    sessionLoadFailed,
    retryLoadSession,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
  };
}
