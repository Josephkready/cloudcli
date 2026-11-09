import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';

import type { Project, ProjectSession } from '@/types/app';
import type { SessionStore } from '@/stores/useSessionStore';
import type { NormalizedMessage } from '@/stores/useSessionStore.pure';

import { useChatSessionState } from './useChatSessionState';

/*
 * cloudcli#591 "No scroll up" (iPhone, antigravity). The first history page
 * rendered shorter than the pane, so there was nothing to scroll, no scroll
 * event ever fired, and the older pages could never load.
 */

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));

const project = { projectId: 'p1', displayName: 'demo', fullPath: '/repo/demo' } as Project;
const session = { id: 's1' } as ProjectSession;

function msg(i: number): NormalizedMessage {
  return {
    id: `m${i}`,
    sessionId: 's1',
    timestamp: new Date(1700000000000 + i * 1000).toISOString(),
    provider: 'antigravity',
    kind: 'text',
    role: 'assistant',
    content: `message ${i}`,
  } as NormalizedMessage;
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function makeContainer(scrollHeight: number): HTMLDivElement {
  const c = document.createElement('div');
  c.appendChild(document.createElement('div'));
  Object.defineProperty(c, 'scrollHeight', { get: () => scrollHeight, configurable: true });
  Object.defineProperty(c, 'clientHeight', { get: () => 600, configurable: true });
  document.body.appendChild(c);
  return c;
}

function render(container: HTMLDivElement, fetchMore: ReturnType<typeof vi.fn>) {
  const messages = [msg(0)];
  const sessionStore = {
    has: () => true,
    isStale: () => false,
    getMessages: () => messages,
    getSessionSlot: () => ({ hasMore: true, total: 50, messages }),
    setActiveSession: vi.fn(),
    noteProvider: vi.fn(),
    hydrateFromCache: vi.fn(async () => false),
    appendRealtime: vi.fn(),
    clearRealtime: vi.fn(),
    fetchMore,
    refreshFromServer: vi.fn(async () => null),
    fetchFromServer: vi.fn(async () => ({ hasMore: true, total: 50, messages })),
  } as unknown as SessionStore;
  return renderHook(() => {
    const state = useChatSessionState({
      selectedProject: project,
      selectedSession: session,
      ws: null,
      sendMessage: vi.fn(),
      statusCheckSentAtRef: { current: new Map<string, number>() },
      lastSeqRef: { current: new Map<string, number>() },
      sessionStore,
    });
    (state.scrollContainerRef as MutableRefObject<HTMLDivElement | null>).current = container;
    return state;
  });
}

describe('useChatSessionState — non-overflowing first page (#591)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 16) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (h: number) =>
      clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('loads older messages without any scroll event when the page does not fill the pane', async () => {
    const fetchMore = vi.fn(async () => null);
    render(makeContainer(300), fetchMore);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(fetchMore).toHaveBeenCalled();
  });

  it('does not fetch extra pages when the pane already overflows', async () => {
    const fetchMore = vi.fn(async () => null);
    render(makeContainer(2000), fetchMore);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(fetchMore).not.toHaveBeenCalled();
  });
});
