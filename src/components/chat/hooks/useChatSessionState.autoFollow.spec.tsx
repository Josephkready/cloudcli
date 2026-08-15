import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';

import type { Project, ProjectSession } from '@/types/app';
import type { SessionStore } from '@/stores/useSessionStore';
import type { NormalizedMessage } from '@/stores/useSessionStore.pure';

import { MAX_GESTURE_MS } from '../utils/autoFollow';

import { useChatSessionState } from './useChatSessionState';

/*
 * #333 — "you start scrolling and it jumps, maybe when message is finished
 * streaming", iPhone, Safari 26.6.
 *
 * Every message that lands schedules a scroll-to-bottom 50ms later, so the
 * freshly appended message is laid out before the pane is re-pinned. The bug
 * was that the scheduled call re-checked nothing: a touch drag begun inside
 * that window was silently undone. On a phone that window is wide enough to
 * catch the *start* of nearly every gesture, which is exactly what the report
 * describes.
 *
 * These exercise the wiring — real container, real listeners, real timer —
 * because the arithmetic in ../utils/autoFollow is already covered and the
 * regression lives in when the decision is made, not what it decides.
 */

// The hook fetches token usage on mount; it is irrelevant here, but an
// undefined response would log a failure on every test.
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));

const SCROLL_HEIGHT = 1000;
const CLIENT_HEIGHT = 600;
const AT_BOTTOM = SCROLL_HEIGHT - CLIENT_HEIGHT; // 400

const project = { projectId: 'p1', displayName: 'demo', fullPath: '/repo/demo' } as Project;
const session = { id: 's1' } as ProjectSession;

function makeMessage(index: number): NormalizedMessage {
  return {
    id: `m${index}`,
    sessionId: 's1',
    timestamp: new Date(1700000000000 + index * 1000).toISOString(),
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: `message ${index}`,
  };
}

/**
 * jsdom ships no ResizeObserver. The hook uses one to track a streaming message
 * growing, so the fake records observers and lets a test fire them by hand.
 */
const resizeCallbacks: Array<() => void> = [];

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}

  observe() {
    resizeCallbacks.push(this.callback);
  }

  disconnect() {
    const index = resizeCallbacks.indexOf(this.callback);
    if (index >= 0) resizeCallbacks.splice(index, 1);
  }

  unobserve() {}
}

/** The content box grew — what a streaming answer does between message arrivals. */
function growContent() {
  act(() => {
    for (const callback of [...resizeCallbacks]) callback();
  });
}

/** A container whose scroll geometry the test controls, since jsdom has no layout. */
function makeContainer(): HTMLDivElement {
  const container = document.createElement('div');
  // The hook observes the content wrapper, so the container needs one.
  container.appendChild(document.createElement('div'));
  let scrollTop = AT_BOTTOM;
  Object.defineProperty(container, 'scrollTop', {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
    configurable: true,
  });
  Object.defineProperty(container, 'scrollHeight', { get: () => SCROLL_HEIGHT, configurable: true });
  Object.defineProperty(container, 'clientHeight', { get: () => CLIENT_HEIGHT, configurable: true });
  document.body.appendChild(container);
  return container;
}

function renderChat(container: HTMLDivElement) {
  // Replaced, never mutated: the real store hands out a fresh array per change
  // and the hook's memo keys off that identity.
  let messages: NormalizedMessage[] = [makeMessage(0)];

  const sessionStore = {
    has: () => true,
    isStale: () => false,
    getMessages: () => messages,
    getSessionSlot: () => ({ hasMore: false, total: messages.length, messages }),
    setActiveSession: vi.fn(),
    appendRealtime: vi.fn(),
    clearRealtime: vi.fn(),
    fetchMore: vi.fn(async () => null),
    refreshFromServer: vi.fn(async () => null),
    fetchFromServer: vi.fn(async () => ({ hasMore: false, total: messages.length, messages })),
  } as unknown as SessionStore;

  const sendMessage = vi.fn();
  const resetStreamingState = vi.fn();
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const lastSeqRef = { current: new Map<string, number>() };

  const view = renderHook(() => {
    const state = useChatSessionState({
      selectedProject: project,
      selectedSession: session,
      ws: null,
      sendMessage,
      resetStreamingState,
      statusCheckSentAtRef,
      lastSeqRef,
      sessionStore,
    });
    // Assigned during render so the hook's effects see the container on their
    // first pass — a ref set afterwards would never re-run the listener effect.
    (state.scrollContainerRef as MutableRefObject<HTMLDivElement | null>).current = container;
    return state;
  });

  /** A new message lands, the way a streaming run delivers one. */
  const deliverMessage = () => {
    const before = view.result.current.chatMessages.length;
    messages = [...messages, makeMessage(messages.length)];
    act(() => {
      view.rerender();
    });
    // Guards against a silently vacuous suite: if the fixture stopped producing
    // renderable messages, every "it did not scroll" assertion would pass for
    // the wrong reason.
    expect(view.result.current.chatMessages.length).toBe(before + 1);
  };

  return { ...view, deliverMessage };
}

/** The landing pass re-pins the bottom every frame for ~1s; get past it. */
function settleInitialScroll(container: HTMLDivElement) {
  act(() => {
    vi.advanceTimersByTime(1200);
  });
  // Finish the way a browser would: the programmatic write emits a scroll
  // event, so the hook's own bookkeeping agrees the pane is at the bottom.
  act(() => {
    container.scrollTop = AT_BOTTOM;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

function touch(container: HTMLDivElement, type: 'touchstart' | 'touchend' | 'touchcancel') {
  act(() => {
    container.dispatchEvent(new Event(type, { bubbles: true }));
  });
}

function scrollTo(container: HTMLDivElement, top: number) {
  act(() => {
    container.scrollTop = top;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

describe('useChatSessionState — mobile auto-follow (#333)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // Route animation frames through the fake clock. The hook's landing pass is
    // a rAF loop, and until it finishes it owns the scroll position — leaving it
    // pending would make every assertion below measure the wrong thing.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 16) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));
    resizeCallbacks.length = 0;
    container = makeContainer();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    container.remove();
  });

  it('follows a new message when the pane is pinned to the bottom and untouched', () => {
    const { deliverMessage } = renderChat(container);
    settleInitialScroll(container);

    deliverMessage();
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(container.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('does not yank the pane back when a drag starts inside the scheduled window', () => {
    const { deliverMessage } = renderChat(container);
    settleInitialScroll(container);

    // Resting 20px up — inside the near-bottom band, and with no finger down
    // this does not count as taking control, so following stays armed.
    scrollTo(container, AT_BOTTOM - 20);

    // The message lands and arms the follow...
    deliverMessage();
    // ...and the reader is mid-gesture before the 50ms elapses. This is the
    // exact race in #333: the old code fired regardless and jumped.
    //
    // The gesture moves *downward*, so neither "scrolled up" nor the
    // suspension rule applies — the finger alone is what has to stop the
    // write. iOS runs its own momentum through a programmatic `scrollTop`, so
    // writing mid-gesture is felt as a jump even when the destination is where
    // the reader was headed anyway.
    touch(container, 'touchstart');
    scrollTo(container, AT_BOTTOM - 10);

    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(container.scrollTop).toBe(AT_BOTTOM - 10);
  });

  it('holds position while the finger is still down, however many messages land', () => {
    const { deliverMessage } = renderChat(container);
    settleInitialScroll(container);

    // Again inside the band and downward: only the pointer state holds it.
    scrollTo(container, AT_BOTTOM - 20);
    touch(container, 'touchstart');
    scrollTo(container, AT_BOTTOM - 15);

    for (let i = 0; i < 3; i += 1) {
      deliverMessage();
      act(() => {
        vi.advanceTimersByTime(50);
      });
    }

    expect(container.scrollTop).toBe(AT_BOTTOM - 15);

    // And the pane follows again once the finger lifts and a message lands.
    touch(container, 'touchend');
    scrollTo(container, AT_BOTTOM);
    deliverMessage();
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(container.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('keeps following suspended after a short drag that stays inside the near-bottom band', () => {
    const { deliverMessage } = renderChat(container);
    settleInitialScroll(container);

    // 20px up — still "near bottom", so the pre-fix threshold rule left
    // following armed and every subsequent message snapped the reader down.
    touch(container, 'touchstart');
    scrollTo(container, AT_BOTTOM - 20);
    touch(container, 'touchend');

    deliverMessage();
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(container.scrollTop).toBe(AT_BOTTOM - 20);
  });

  it('resumes following once the reader returns to the bottom', () => {
    const { deliverMessage } = renderChat(container);
    settleInitialScroll(container);

    touch(container, 'touchstart');
    scrollTo(container, AT_BOTTOM - 20);
    touch(container, 'touchend');
    // Scrolled back and parked at the very bottom: they want to be pinned again.
    scrollTo(container, AT_BOTTOM);

    deliverMessage();
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(container.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('leaves a reader who scrolled well up exactly where they are', () => {
    const { deliverMessage } = renderChat(container);
    settleInitialScroll(container);

    scrollTo(container, 120);

    deliverMessage();
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(container.scrollTop).toBe(120);
  });

  it('tracks a streaming message as its body grows, with no message arriving', () => {
    renderChat(container);
    settleInitialScroll(container);

    // One assistant message whose content keeps growing. `chatMessages.length`
    // never changes, so before the content observer nothing re-pinned the pane
    // and the whole run's output piled up below the fold.
    container.scrollTop = AT_BOTTOM - 200;
    growContent();

    expect(container.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('does not track streaming growth for a reader who has scrolled away', () => {
    renderChat(container);
    settleInitialScroll(container);

    scrollTo(container, 120);
    growContent();

    expect(container.scrollTop).toBe(120);
  });

  it('does not track streaming growth while a finger is on the glass', () => {
    renderChat(container);
    settleInitialScroll(container);

    scrollTo(container, AT_BOTTOM - 20);
    touch(container, 'touchstart');
    scrollTo(container, AT_BOTTOM - 10);
    growContent();

    expect(container.scrollTop).toBe(AT_BOTTOM - 10);
  });

  it('releases the pointer gate on touchcancel, not just touchend', () => {
    const { deliverMessage } = renderChat(container);
    settleInitialScroll(container);

    // iOS cancels the sequence when a system gesture takes over. If only
    // touchend released the gate, following would stay off for good.
    touch(container, 'touchstart');
    touch(container, 'touchcancel');

    deliverMessage();
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(container.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('expires a gesture that never reported an end, instead of wedging follow off', () => {
    const { deliverMessage } = renderChat(container);
    settleInitialScroll(container);

    // A touch sequence that delivers neither touchend nor touchcancel would
    // otherwise pin the gate on and silently disable following for the session.
    touch(container, 'touchstart');
    act(() => {
      vi.advanceTimersByTime(MAX_GESTURE_MS + 1000);
    });

    deliverMessage();
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(container.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('re-arms following when the reader asks for the bottom explicitly', () => {
    const { result, deliverMessage } = renderChat(container);
    settleInitialScroll(container);

    touch(container, 'touchstart');
    scrollTo(container, 120);
    touch(container, 'touchend');

    act(() => {
      result.current.scrollToBottom();
    });
    expect(container.scrollTop).toBe(SCROLL_HEIGHT);

    // And following stays armed afterwards — this is the path sending a
    // message takes.
    container.scrollTop = AT_BOTTOM;
    deliverMessage();
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(container.scrollTop).toBe(SCROLL_HEIGHT);
  });
});
