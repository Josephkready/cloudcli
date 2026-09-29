import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// WP4 #1 (E.report.md finding 1): the auth boot sequence used to be a strict
// status -> user -> onboarding -> projects waterfall (4 serial round trips)
// before ProtectedRoute would even mount the part of the tree that fetches
// projects. This spec proves the fixed shape with delayed mocks: each mock
// resolves after DELAY_MS, and we assert both the wall-clock time and the
// call-start timestamps to show user/onboarding/projects genuinely overlap
// instead of chaining.

const config = vi.hoisted(() => ({ IS_PLATFORM: false, AUTH_DISABLED: false }));
vi.mock('@/constants/config', () => config);
vi.mock('../../constants/config', () => config);

// Large enough that jsdom/test-scheduler overhead (observed ~70-90ms fixed
// cost on a loaded box) is a small fraction of the total, so the wall-clock
// assertion below isn't timing-fragile.
const DELAY_MS = 100;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

let calls: { name: string; at: number }[] = [];

const api = {
  auth: {
    status: vi.fn(async () => {
      calls.push({ name: 'auth.status', at: performance.now() });
      await delay(DELAY_MS);
      return jsonResponse({ needsSetup: false });
    }),
    user: vi.fn(async () => {
      calls.push({ name: 'auth.user', at: performance.now() });
      await delay(DELAY_MS);
      return jsonResponse({ user: { username: 'jo' } });
    }),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  },
  user: {
    onboardingStatus: vi.fn(async () => {
      calls.push({ name: 'user.onboardingStatus', at: performance.now() });
      await delay(DELAY_MS);
      return jsonResponse({ hasCompletedOnboarding: true });
    }),
  },
  projects: vi.fn(async () => {
    calls.push({ name: 'projects', at: performance.now() });
    await delay(DELAY_MS);
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
    calls = [];
    localStorage.clear();
    config.IS_PLATFORM = false;
    config.AUTH_DISABLED = false;
    vi.clearAllMocks();
    __resetProjectsBootPrefetchForTests();
  });

  it('overlaps auth.user, onboardingStatus, and the projects prefetch instead of chaining 4 serial hops', async () => {
    localStorage.setItem('auth-token', 'stored-token');
    const start = performance.now();

    render(
      <AuthProvider>
        <ProtectedRoute>
          <ProjectsProbe />
        </ProtectedRoute>
      </AuthProvider>,
    );

    await waitFor(
      () => expect(screen.getByTestId('projects-loading')).toHaveTextContent('false'),
      { timeout: 2000 },
    );
    const totalMs = performance.now() - start;

    // Old (serial) shape: status -> user -> onboarding -> projects would be
    // ~4 * DELAY_MS end-to-end. New shape collapses that to two sequential
    // hops (status, then everything else in parallel) -- ~2 * DELAY_MS ideal.
    // The per-call timestamp assertions below are the precise proof of
    // parallelism; this wall-clock check only needs to rule out the old
    // 4-hop total, with generous headroom for jsdom/test-scheduler overhead.
    expect(totalMs).toBeLessThan(3.5 * DELAY_MS);

    const at = (name: string) => calls.find((call) => call.name === name)?.at;
    const statusAt = at('auth.status');
    const projectsAt = at('projects');
    const userAt = at('auth.user');
    const onboardingAt = at('user.onboardingStatus');

    expect(statusAt).toBeDefined();
    expect(projectsAt).toBeDefined();
    expect(userAt).toBeDefined();
    expect(onboardingAt).toBeDefined();

    // The projects prefetch starts immediately alongside auth.status --
    // before auth even resolves -- rather than waiting for the whole auth
    // chain (status -> user -> onboarding) to finish first.
    expect(Math.abs(projectsAt! - statusAt!)).toBeLessThan(DELAY_MS / 2);

    // user and onboardingStatus fire together (Promise.all), not chained
    // one after the other.
    expect(Math.abs(userAt! - onboardingAt!)).toBeLessThan(DELAY_MS / 2);

    // user/onboarding only start once status has resolved (real dependency).
    expect(userAt!).toBeGreaterThanOrEqual(statusAt! + DELAY_MS - 1);

    // Serial depth: at most 2 hops on the critical path (status, then the
    // parallel user/onboarding batch) -- not 4.
    expect(calls).toHaveLength(4);
  });
});
