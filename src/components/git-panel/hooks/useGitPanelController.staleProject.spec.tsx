import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../types/app';

const { authenticatedFetch } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({ authenticatedFetch }));
vi.mock('../../../utils/featureUsage', () => ({ recordFeatureUse: vi.fn() }));
vi.mock('./useSelectedProvider', () => ({ useSelectedProvider: () => 'claude' }));

const { useGitPanelController } = await import('./useGitPanelController');

const project = (projectId: string): Project => ({
  projectId,
  displayName: projectId,
  fullPath: `/repos/${projectId}`,
});

const response = (data: unknown): Response => ({
  ok: true,
  json: async () => data,
} as Response);

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function projectIdFromRequest(url: string, options?: RequestInit): string {
  const queryProject = new URL(url, 'https://cloudcli.test').searchParams.get('project');
  if (queryProject) {
    return queryProject;
  }
  const body = typeof options?.body === 'string' ? JSON.parse(options.body) as { project?: string } : {};
  return body.project ?? '';
}

describe('useGitPanelController project-switch guards', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
  });

  it('ignores repository reads that finish after the selected project changes', async () => {
    const staleBranches = deferred<Response>();
    const staleRemote = deferred<Response>();
    const staleCommits = deferred<Response>();

    authenticatedFetch.mockImplementation((urlValue: string, options?: RequestInit) => {
      const url = String(urlValue);
      const requestProjectId = projectIdFromRequest(url, options);
      if (requestProjectId === 'A') {
        if (url.includes('/branches')) return staleBranches.promise;
        if (url.includes('/remote-status')) return staleRemote.promise;
        if (url.includes('/commits')) return staleCommits.promise;
      }

      if (url.includes('/status')) return Promise.resolve(response({ branch: `${requestProjectId}-main` }));
      if (url.includes('/branches')) {
        return Promise.resolve(response({
          branches: [`${requestProjectId}-main`],
          localBranches: [`${requestProjectId}-main`],
          remoteBranches: [`origin/${requestProjectId}-main`],
        }));
      }
      if (url.includes('/remote-status')) {
        return Promise.resolve(response({ branch: `${requestProjectId}-main`, ahead: requestProjectId === 'B' ? 2 : 9 }));
      }
      if (url.includes('/commits')) {
        return Promise.resolve(response({ commits: [{
          hash: `${requestProjectId}-hash`,
          author: 'Test',
          date: '2026-08-23T00:00:00.000Z',
          message: `${requestProjectId} commit`,
        }] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const view = renderHook(
      ({ selectedProject }) => useGitPanelController({ selectedProject, activeView: 'history' }),
      { initialProps: { selectedProject: project('A') } },
    );

    view.rerender({ selectedProject: project('B') });
    await waitFor(() => expect(view.result.current.branches).toEqual(['B-main']));
    await waitFor(() => expect(view.result.current.remoteStatus?.ahead).toBe(2));
    await waitFor(() => expect(view.result.current.recentCommits[0]?.hash).toBe('B-hash'));

    await act(async () => {
      staleBranches.resolve(response({ branches: ['A-main'] }));
      staleRemote.resolve(response({ branch: 'A-main', ahead: 9 }));
      staleCommits.resolve(response({ commits: [{
        hash: 'A-hash',
        author: 'Test',
        date: '2026-08-23T00:00:00.000Z',
        message: 'A commit',
      }] }));
      await Promise.resolve();
    });

    expect(view.result.current.branches).toEqual(['B-main']);
    expect(view.result.current.remoteStatus?.ahead).toBe(2);
    expect(view.result.current.recentCommits[0]?.hash).toBe('B-hash');
  });

  it('does not apply a mutation success response to the newly selected project', async () => {
    const staleCheckout = deferred<Response>();

    authenticatedFetch.mockImplementation((urlValue: string, options?: RequestInit) => {
      const url = String(urlValue);
      const requestProjectId = projectIdFromRequest(url, options);
      if (url.includes('/checkout') && requestProjectId === 'A') {
        return staleCheckout.promise;
      }
      if (url.includes('/status')) return Promise.resolve(response({ branch: `${requestProjectId}-main` }));
      if (url.includes('/branches')) return Promise.resolve(response({ branches: [`${requestProjectId}-main`] }));
      if (url.includes('/remote-status')) return Promise.resolve(response({ branch: `${requestProjectId}-main` }));
      throw new Error(`Unexpected request: ${url}`);
    });

    const view = renderHook(
      ({ selectedProject }) => useGitPanelController({ selectedProject, activeView: 'changes' }),
      { initialProps: { selectedProject: project('A') } },
    );
    await waitFor(() => expect(view.result.current.currentBranch).toBe('A-main'));

    let switchResult: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      switchResult = view.result.current.switchBranch('A-old-branch');
      await Promise.resolve();
    });

    view.rerender({ selectedProject: project('B') });
    await waitFor(() => expect(view.result.current.currentBranch).toBe('B-main'));

    staleCheckout.resolve(response({ success: true }));
    await expect(switchResult).resolves.toBe(false);
    expect(view.result.current.currentBranch).toBe('B-main');
  });
});
