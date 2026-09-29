import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../types/app';

const projectsFetch = vi.fn();

vi.mock('@/utils/api', () => ({ api: { projects: (...args: unknown[]) => projectsFetch(...args) } }));
vi.mock('../utils/api', () => ({ api: { projects: (...args: unknown[]) => projectsFetch(...args) } }));

const {
  startProjectsBootPrefetch,
  consumeProjectsBootPrefetch,
  discardProjectsBootPrefetch,
  __resetProjectsBootPrefetchForTests,
} = await import('./projectsBootPrefetch');

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const sampleProjects: Project[] = [
  { projectId: 'p1', displayName: 'P1', fullPath: '/p1', sessions: [] },
];

describe('projectsBootPrefetch', () => {
  beforeEach(() => {
    projectsFetch.mockReset();
    __resetProjectsBootPrefetchForTests();
  });

  afterEach(() => {
    __resetProjectsBootPrefetchForTests();
  });

  it('does nothing until started', () => {
    expect(consumeProjectsBootPrefetch()).toBeNull();
  });

  it('starts exactly one request even if called multiple times before consuming', () => {
    projectsFetch.mockResolvedValue(jsonResponse(sampleProjects));

    startProjectsBootPrefetch();
    startProjectsBootPrefetch();
    startProjectsBootPrefetch();

    expect(projectsFetch).toHaveBeenCalledTimes(1);
  });

  it('consume returns the in-flight promise, resolving to the fetched projects', async () => {
    projectsFetch.mockResolvedValue(jsonResponse(sampleProjects));

    startProjectsBootPrefetch();
    const promise = consumeProjectsBootPrefetch();
    expect(promise).not.toBeNull();
    await expect(promise).resolves.toEqual(sampleProjects);
  });

  it('consume returns null once already consumed -- a second caller falls back to its own fetch', () => {
    projectsFetch.mockResolvedValue(jsonResponse(sampleProjects));

    startProjectsBootPrefetch();
    consumeProjectsBootPrefetch();
    expect(consumeProjectsBootPrefetch()).toBeNull();
  });

  it('starting again after a consume issues a fresh request', () => {
    projectsFetch.mockResolvedValue(jsonResponse(sampleProjects));

    startProjectsBootPrefetch();
    consumeProjectsBootPrefetch();
    startProjectsBootPrefetch();

    expect(projectsFetch).toHaveBeenCalledTimes(2);
  });

  it('discard makes a subsequent consume return null', () => {
    projectsFetch.mockResolvedValue(jsonResponse(sampleProjects));

    startProjectsBootPrefetch();
    discardProjectsBootPrefetch();

    expect(consumeProjectsBootPrefetch()).toBeNull();
  });

  it('discarding before a rejecting prefetch settles does not produce an unhandled rejection', async () => {
    let rejectFetch: (error: Error) => void = () => {};
    projectsFetch.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );

    startProjectsBootPrefetch();
    discardProjectsBootPrefetch();

    // Reject only after discarding -- this is exactly the "invalid token,
    // discard immediately, prefetch rejects later" boot sequence. Vitest fails
    // the run on an unhandled rejection, so this test passing at all (not
    // just the final assertion) is the regression check for that bug.
    rejectFetch(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consumeProjectsBootPrefetch()).toBeNull();
  });

  it('a non-ok response surfaces as a rejection to whoever consumes it', async () => {
    projectsFetch.mockResolvedValue(jsonResponse({}, false));

    startProjectsBootPrefetch();
    const promise = consumeProjectsBootPrefetch();
    expect(promise).not.toBeNull();
    await expect(promise).rejects.toThrow(/Projects boot prefetch failed with status/);
  });
});
