import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PaletteOpsProvider } from '../../../contexts/PaletteOpsContext';

const searchConversationsUrl = vi.fn((query: string) => `/search?q=${query}`);
const streamAuthenticatedSse = vi.fn();

const emptyJsonResponse = () => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => ({ data: { projects: [], sessions: [] } }),
});

vi.mock('../../../utils/api', () => ({
  api: {
    archivedProjects: emptyJsonResponse,
    getArchivedSessions: emptyJsonResponse,
    searchConversationsUrl,
  },
}));

vi.mock('../../../utils/sse', () => ({
  streamAuthenticatedSse: (...args: unknown[]) => streamAuthenticatedSse(...args),
}));

const { useSidebarController } = await import('./useSidebarController');

type SseCallback = (event: { event: string; data: string }) => void;

const wrapper = ({ children }: { children: ReactNode }) => (
  <PaletteOpsProvider>{children}</PaletteOpsProvider>
);

const args = {
  projects: [],
  selectedProject: null,
  selectedSession: null,
  activeSessions: new Map(),
  isLoading: false,
  isMobile: false,
  t: ((key: string, fallback?: string) => fallback ?? key) as never,
  onRefresh: () => {},
  onProjectSelect: () => {},
  onSessionSelect: () => {},
  setSidebarVisible: () => {},
  sidebarVisible: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  searchConversationsUrl.mockClear();
  streamAuthenticatedSse.mockReset();
  streamAuthenticatedSse.mockImplementation(() => new Promise<void>(() => {}));
});

describe('sidebar conversation-search SSE lifecycle', () => {
  it('streams progress/results, aborts replaced searches, and ignores stale events', async () => {
    const callbacks: SseCallback[] = [];
    const signals: AbortSignal[] = [];
    streamAuthenticatedSse.mockImplementation((_url, callback, options) => {
      callbacks.push(callback as SseCallback);
      signals.push((options as RequestInit).signal as AbortSignal);
      return new Promise<void>(() => {});
    });

    const view = renderHook(() => useSidebarController(args), { wrapper });
    await act(async () => Promise.resolve());
    act(() => {
      view.result.current.setSidebarOverlay('search');
      view.result.current.setSearchFilter('first');
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));

    act(() => callbacks[0]?.({
      event: 'progress',
      data: JSON.stringify({ totalMatches: 0, scannedProjects: 1, totalProjects: 3 }),
    }));
    expect(view.result.current.searchProgress).toEqual({ scannedProjects: 1, totalProjects: 3 });

    act(() => callbacks[0]?.({
      event: 'result',
      data: JSON.stringify({
        projectResult: {
          projectId: 'p1',
          projectName: 'project',
          projectDisplayName: 'Project',
          sessions: [],
        },
        totalMatches: 1,
        scannedProjects: 2,
        totalProjects: 3,
      }),
    }));
    expect(view.result.current.conversationResults?.results).toHaveLength(1);

    act(() => view.result.current.setSearchFilter('second'));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(signals[0]?.aborted).toBe(true);

    act(() => callbacks[0]?.({
      event: 'result',
      data: JSON.stringify({
        projectResult: {
          projectId: 'stale',
          projectName: 'stale',
          projectDisplayName: 'Stale',
          sessions: [],
        },
        totalMatches: 2,
        scannedProjects: 3,
        totalProjects: 3,
      }),
    }));
    expect(view.result.current.conversationResults?.results).toHaveLength(1);

    act(() => callbacks[1]?.({ event: 'error', data: '{}' }));
    expect(signals[1]?.aborted).toBe(true);
    expect(view.result.current.isSearching).toBe(false);
    expect(view.result.current.searchProgress).toBeNull();
  });
});
