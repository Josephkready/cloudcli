import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// WP4 #1 (E.report.md finding 1): the auth boot sequence used to be a strict
// status -> user -> onboarding -> projects waterfall (4 serial round trips)
// before ProtectedRoute would even mount the part of the tree that fetches
// projects. This spec proves the fixed shape with delayed mocks: each mock
// logs a start and an end event, and we assert on the ORDER of those events
// (which call started before which resolved) rather than on wall-clock time,
// so the proof holds however loaded the box running it is.

const config = vi.hoisted(() => ({ IS_PLATFORM: false, AUTH_DISABLED: false }));
vi.mock('@/constants/config', () => config);
vi.mock('../../constants/config', () => config);

const DELAY_MS = 20;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

let events: string[] = [];

const api = {
  auth: {
    status: vi.fn(async () => {
      events.push('start:auth.status');
      await delay(DELAY_MS);
      events.push('end:auth.status');
      return jsonResponse({ needsSetup: false });
    }),
    user: vi.fn(async () => {
      events.push('start:auth.user');
      await delay(DELAY_MS);
      events.push('end:auth.user');
      return jsonResponse({ user: { username: 'jo' } });
    }),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  },
  user: {
    onboardingStatus: vi.fn(async () => {
      events.push('start:user.onboardingStatus');
      await delay(DELAY_MS);
      events.push('end:user.onboardingStatus');
      return jsonResponse({ hasCompletedOnboarding: true });
    }),
  },
  projects: vi.fn(async () => {
    events.push('start:projects');
    await delay(DELAY_MS);
    events.push('end:projects');
    return jsonResponse([]);
  }),
};

vi.mock('@/utils/api', () => ({ api }));
vi.mock('../../utils/api', () => ({ api }));

const { AuthProvider } = await import('../auth/context/AuthContext');
const ProtectedRouteModule = await import('../auth/view/ProtectedRoute');
const ProtectedRoute = ProtectedRouteModule.default;
const { useProjectsState } = await import('../../hooks/useProjectsState');
const { __resetProjectsBootPrefetchForTests } = await import('../../hooks/projectsBootPrefetch');

function ProjectsProbe() {
  const subscribe = () => () => {};
  const state = useProjectsState({
    navigate: vi.fn() as never,
    subscribe,
    isMobile: false,
    activeSessions: new Map(),
  });
  return <span data-testid="projects-loading">{String(state.isLoadingProjects)}</span>;
}

describe('app boot waterfall (WP4 #1)', () => {
  beforeEach(() => {
    events = [];
    localStorage.clear();
    config.IS_PLATFORM = false;
    config.AUTH_DISABLED = false;
    vi.clearAllMocks();
    __resetProjectsBootPrefetchForTests();
  });

  it('overlaps auth.user, onboardingStatus, and the projects prefetch instead of chaining 4 serial hops', async () => {
    localStorage.setItem('auth-token', 'stored-token');

    render(
      <AuthProvider>
        <ProtectedRoute>
          <ProjectsProbe />
        </ProtectedRoute>
      </AuthProvider>,
    );

    await waitFor(
      () => expect(screen.getByTestId('projects-loading')).toHaveTextContent('false'),
      { timeout: 10_000 },
    );
    const idx = (event: string) => {
      const i = events.indexOf(event);
      expect(i, `missing ${event} in ${events.join(', ')}`).toBeGreaterThanOrEqual(0);
      return i;
    };

    // The projects prefetch starts alongside auth.status -- before auth even
    // resolves -- rather than waiting for the whole auth chain to finish.
    expect(idx('start:projects')).toBeLessThan(idx('end:auth.status'));

    // user and onboardingStatus fire together (Promise.all): both have
    // started before either resolves, i.e. they are not chained.
    const userStart = idx('start:auth.user');
    const onboardingStart = idx('start:user.onboardingStatus');
    const firstOfPairEnds = Math.min(idx('end:auth.user'), idx('end:user.onboardingStatus'));
    expect(Math.max(userStart, onboardingStart)).toBeLessThan(firstOfPairEnds);

    // user/onboarding only start once status has resolved (real dependency).
    expect(userStart).toBeGreaterThan(idx('end:auth.status'));

    // Serial depth: at most 2 hops on the critical path (status, then the
    // parallel user/onboarding batch) -- not 4. Each call happens once.
    expect(events.filter((event) => event.startsWith('start:'))).toHaveLength(4);
  });
});
