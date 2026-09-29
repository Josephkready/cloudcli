import { api } from '../utils/api';
import type { Project } from '../types/app';

// Module-level so it survives across the auth-boot render cycle: started
// once, as early as possible (AuthContext's mount effect), and consumed at
// most once by useProjectsState's very first fetchProjects() call.
let prefetchPromise: Promise<Project[]> | null = null;

/**
 * Starts `GET /api/projects` immediately, in parallel with the auth boot
 * sequence (`AuthContext.checkAuthStatus`), instead of waiting for
 * `ProtectedRoute` to mount `AppContent` only after auth fully resolves
 * (status -> user -> onboarding). Call exactly once per boot attempt, and
 * only when the caller already has good reason to expect the request will
 * be authorized (auth disabled / platform mode, or a token is already
 * stored) — an unauthorized request still safely fails server-side, it's
 * just wasted work.
 */
export const startProjectsBootPrefetch = (): void => {
  if (prefetchPromise) {
    return;
  }

  prefetchPromise = api.projects({}).then((response) => {
    if (!response.ok) {
      throw new Error(`Projects boot prefetch failed with status ${response.status}`);
    }
    return response.json() as Promise<Project[]>;
  });
};

/**
 * Consumed at most once, by `useProjectsState`'s very first `fetchProjects()`
 * call (when it has no projects loaded yet). Returns `null` if no prefetch
 * was started, or it was already consumed/discarded, so the caller falls
 * back to its own fetch.
 */
export const consumeProjectsBootPrefetch = (): Promise<Project[]> | null => {
  const promise = prefetchPromise;
  prefetchPromise = null;
  return promise;
};

/**
 * Called whenever auth turns out invalid (or a fresh boot begins) so a
 * stale in-flight/resolved prefetch from a *previous* session is never
 * handed to `useProjectsState` as if it belonged to the new one — e.g. the
 * sequence "boot with a stale token -> 401 -> log in as someone else"
 * without a full page reload in between.
 */
export const discardProjectsBootPrefetch = (): void => {
  prefetchPromise = null;
};

/** Test-only: reset module state between specs. */
export const __resetProjectsBootPrefetchForTests = (): void => {
  prefetchPromise = null;
};
