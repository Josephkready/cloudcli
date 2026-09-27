import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../types/app';

const getFilesMock = vi.fn();

vi.mock('../utils/api', () => ({
  api: {
    getFiles: (...args: unknown[]) => getFilesMock(...args),
  },
}));

const { useFileOpenResolver } = await import('./useFileOpenResolver');

/**
 * `useFileOpenResolver` resolves a bare/partial file reference (as chat
 * messages tend to contain) against the project's file tree before handing
 * it to `onFileOpen`. The tree fetch (`api.getFiles`) is cached per project
 * and is the one true external boundary here.
 */

function project(projectId: string): Project {
  return { projectId } as Project;
}

function okResponse(tree: unknown) {
  return { ok: true, json: async () => tree };
}

function fileNode(name: string, path: string) {
  return { type: 'file' as const, name, path };
}

function dirNode(name: string, path: string, children: unknown[]) {
  return { type: 'directory' as const, name, path, children };
}

beforeEach(() => {
  getFilesMock.mockReset();
});

async function resolveOnce(filePath: string, selectedProject: Project | null | undefined) {
  const onFileOpen = vi.fn();
  const { result } = renderHook(() => useFileOpenResolver(selectedProject, onFileOpen));

  await act(async () => {
    result.current(filePath, { some: 'diff' });
    // flush the microtask chain inside the resolver's `.then`
    await Promise.resolve();
    await Promise.resolve();
  });

  return onFileOpen;
}

describe('useFileOpenResolver — matching', () => {
  it('resolves an exact path match', async () => {
    getFilesMock.mockResolvedValue(okResponse([fileNode('foo.ts', 'src/utils/foo.ts')]));

    const onFileOpen = await resolveOnce('src/utils/foo.ts', project('p1'));

    expect(onFileOpen).toHaveBeenCalledWith('src/utils/foo.ts', { some: 'diff' });
  });

  it('resolves a partial suffix match (utils/foo.ts -> src/utils/foo.ts)', async () => {
    getFilesMock.mockResolvedValue(okResponse([fileNode('foo.ts', 'src/utils/foo.ts')]));

    const onFileOpen = await resolveOnce('utils/foo.ts', project('p1'));

    expect(onFileOpen).toHaveBeenCalledWith('src/utils/foo.ts', { some: 'diff' });
  });

  it('resolves a bare basename match', async () => {
    getFilesMock.mockResolvedValue(
      okResponse([dirNode('src', 'src', [dirNode('utils', 'src/utils', [fileNode('foo.ts', 'src/utils/foo.ts')])])]),
    );

    const onFileOpen = await resolveOnce('foo.ts', project('p1'));

    expect(onFileOpen).toHaveBeenCalledWith('src/utils/foo.ts', { some: 'diff' });
  });

  it('falls back to the original filePath when nothing matches', async () => {
    getFilesMock.mockResolvedValue(okResponse([fileNode('bar.ts', 'src/utils/bar.ts')]));

    const onFileOpen = await resolveOnce('nowhere/missing.ts', project('p1'));

    expect(onFileOpen).toHaveBeenCalledWith('nowhere/missing.ts', { some: 'diff' });
  });
});

describe('useFileOpenResolver — caching', () => {
  it('caches the file tree per project: a second call does not re-fetch', async () => {
    getFilesMock.mockResolvedValue(okResponse([fileNode('foo.ts', 'src/utils/foo.ts')]));
    const onFileOpen = vi.fn();
    const proj = project('p1');
    const { result } = renderHook(() => useFileOpenResolver(proj, onFileOpen));

    await act(async () => {
      result.current('foo.ts');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      result.current('foo.ts');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getFilesMock).toHaveBeenCalledTimes(1);
    expect(onFileOpen).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cache when the projectId changes', async () => {
    getFilesMock
      .mockResolvedValueOnce(okResponse([fileNode('foo.ts', 'src/utils/foo.ts')]))
      .mockResolvedValueOnce(okResponse([fileNode('foo.ts', 'other/foo.ts')]));

    const onFileOpen = vi.fn();
    const { result, rerender } = renderHook(
      ({ p }: { p: Project }) => useFileOpenResolver(p, onFileOpen),
      { initialProps: { p: project('p1') } },
    );

    await act(async () => {
      result.current('foo.ts');
      await Promise.resolve();
      await Promise.resolve();
    });

    rerender({ p: project('p2') });

    await act(async () => {
      result.current('foo.ts');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getFilesMock).toHaveBeenCalledTimes(2);
    expect(getFilesMock).toHaveBeenNthCalledWith(1, 'p1');
    expect(getFilesMock).toHaveBeenNthCalledWith(2, 'p2');
    expect(onFileOpen).toHaveBeenNthCalledWith(1, 'src/utils/foo.ts', undefined);
    expect(onFileOpen).toHaveBeenNthCalledWith(2, 'other/foo.ts', undefined);
  });
});

describe('useFileOpenResolver — error handling', () => {
  it('falls back to filePath when api.getFiles resolves with !ok', async () => {
    getFilesMock.mockResolvedValue({ ok: false, json: async () => ({}) });

    const onFileOpen = await resolveOnce('src/utils/foo.ts', project('p1'));

    expect(onFileOpen).toHaveBeenCalledWith('src/utils/foo.ts', { some: 'diff' });
  });

  it('falls back to filePath when api.getFiles throws', async () => {
    getFilesMock.mockRejectedValue(new Error('network down'));

    const onFileOpen = await resolveOnce('src/utils/foo.ts', project('p1'));

    expect(onFileOpen).toHaveBeenCalledWith('src/utils/foo.ts', { some: 'diff' });
  });
});

describe('useFileOpenResolver — no selected project', () => {
  it('resolves to the original filePath and never calls api.getFiles for null selectedProject', async () => {
    const onFileOpen = await resolveOnce('src/utils/foo.ts', null);

    expect(getFilesMock).not.toHaveBeenCalled();
    expect(onFileOpen).toHaveBeenCalledWith('src/utils/foo.ts', { some: 'diff' });
  });

  it('resolves to the original filePath and never calls api.getFiles for undefined selectedProject', async () => {
    const onFileOpen = await resolveOnce('src/utils/foo.ts', undefined);

    expect(getFilesMock).not.toHaveBeenCalled();
    expect(onFileOpen).toHaveBeenCalledWith('src/utils/foo.ts', { some: 'diff' });
  });
});
