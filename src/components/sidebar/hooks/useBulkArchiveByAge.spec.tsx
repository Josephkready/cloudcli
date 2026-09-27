import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBulkArchiveByAge } from './useBulkArchiveByAge';

const { getArchivableSessionCountByAge, bulkArchiveSessionsByAge } = vi.hoisted(() => ({
  getArchivableSessionCountByAge: vi.fn(),
  bulkArchiveSessionsByAge: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({
  api: { getArchivableSessionCountByAge, bulkArchiveSessionsByAge },
}));

const t = ((key: string, opts?: { defaultValue?: string }) => (
  typeof opts?.defaultValue === 'string' ? opts.defaultValue : key
)) as unknown as import('i18next').TFunction;

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function errResponse(status: number, text = 'boom') {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

describe('useBulkArchiveByAge', () => {
  const refreshProjects = vi.fn();

  beforeEach(() => {
    getArchivableSessionCountByAge.mockReset();
    bulkArchiveSessionsByAge.mockReset();
    refreshProjects.mockReset();
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a confirm prompt naming the previewed count', async () => {
    getArchivableSessionCountByAge.mockResolvedValue(okResponse({ data: { archivableCount: 5 } }));
    const { result } = renderHook(() => useBulkArchiveByAge({ refreshProjects, t }));

    await act(async () => {
      await result.current.bulkArchiveSessionsByAge(30);
    });

    expect(result.current.bulkArchiveByAgePrompt).toMatchObject({
      olderThanDays: 30,
      prompt: { kind: 'confirm' },
    });
  });

  it('opens an inform prompt when nothing qualifies', async () => {
    getArchivableSessionCountByAge.mockResolvedValue(okResponse({ data: { archivableCount: 0 } }));
    const { result } = renderHook(() => useBulkArchiveByAge({ refreshProjects, t }));

    await act(async () => {
      await result.current.bulkArchiveSessionsByAge(14);
    });

    expect(result.current.bulkArchiveByAgePrompt?.prompt.kind).toBe('inform');
  });

  it('falls back to the count-less confirm prompt when the preview response is not ok', async () => {
    getArchivableSessionCountByAge.mockResolvedValue(errResponse(500));
    const { result } = renderHook(() => useBulkArchiveByAge({ refreshProjects, t }));

    await act(async () => {
      await result.current.bulkArchiveSessionsByAge(7);
    });

    expect(result.current.bulkArchiveByAgePrompt?.prompt.kind).toBe('confirm');
  });

  it('falls back to the count-less confirm prompt when the preview request throws', async () => {
    getArchivableSessionCountByAge.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useBulkArchiveByAge({ refreshProjects, t }));

    await act(async () => {
      await result.current.bulkArchiveSessionsByAge(7);
    });

    expect(result.current.bulkArchiveByAgePrompt?.prompt.kind).toBe('confirm');
  });

  it('drops a stale preview if the dialog was dismissed before it resolved', async () => {
    let resolveCount: (value: unknown) => void = () => {};
    getArchivableSessionCountByAge.mockReturnValue(new Promise((resolve) => { resolveCount = resolve; }));
    const { result } = renderHook(() => useBulkArchiveByAge({ refreshProjects, t }));

    let previewPromise: Promise<void>;
    act(() => {
      previewPromise = result.current.bulkArchiveSessionsByAge(30);
    });

    act(() => {
      result.current.cancelBulkArchiveByAge();
    });

    await act(async () => {
      resolveCount(okResponse({ data: { archivableCount: 5 } }));
      await previewPromise;
    });

    expect(result.current.bulkArchiveByAgePrompt).toBeNull();
  });

  it('cancelBulkArchiveByAge dismisses the prompt', async () => {
    getArchivableSessionCountByAge.mockResolvedValue(okResponse({ data: { archivableCount: 3 } }));
    const { result } = renderHook(() => useBulkArchiveByAge({ refreshProjects, t }));

    await act(async () => {
      await result.current.bulkArchiveSessionsByAge(30);
    });
    expect(result.current.bulkArchiveByAgePrompt).not.toBeNull();

    act(() => result.current.cancelBulkArchiveByAge());
    expect(result.current.bulkArchiveByAgePrompt).toBeNull();
  });

  it('confirmBulkArchiveByAge archives and refreshes projects on success', async () => {
    getArchivableSessionCountByAge.mockResolvedValue(okResponse({ data: { archivableCount: 2 } }));
    bulkArchiveSessionsByAge.mockResolvedValue(okResponse({}));
    const { result } = renderHook(() => useBulkArchiveByAge({ refreshProjects, t }));

    await act(async () => {
      await result.current.bulkArchiveSessionsByAge(30);
    });

    await act(async () => {
      await result.current.confirmBulkArchiveByAge();
    });

    expect(bulkArchiveSessionsByAge).toHaveBeenCalledWith(30);
    expect(refreshProjects).toHaveBeenCalled();
    expect(result.current.bulkArchiveByAgePrompt).toBeNull();
  });

  it('confirmBulkArchiveByAge alerts and does not refresh when the archive request fails', async () => {
    getArchivableSessionCountByAge.mockResolvedValue(okResponse({ data: { archivableCount: 2 } }));
    bulkArchiveSessionsByAge.mockResolvedValue(errResponse(500, 'server exploded'));
    const { result } = renderHook(() => useBulkArchiveByAge({ refreshProjects, t }));

    await act(async () => {
      await result.current.bulkArchiveSessionsByAge(30);
    });

    await act(async () => {
      await result.current.confirmBulkArchiveByAge();
    });

    expect(window.alert).toHaveBeenCalled();
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  it('confirmBulkArchiveByAge alerts when the archive request throws', async () => {
    getArchivableSessionCountByAge.mockResolvedValue(okResponse({ data: { archivableCount: 2 } }));
    bulkArchiveSessionsByAge.mockRejectedValue(new Error('kaboom'));
    const { result } = renderHook(() => useBulkArchiveByAge({ refreshProjects, t }));

    await act(async () => {
      await result.current.bulkArchiveSessionsByAge(30);
    });

    await act(async () => {
      await result.current.confirmBulkArchiveByAge();
    });

    expect(window.alert).toHaveBeenCalled();
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  it('confirmBulkArchiveByAge is a no-op for an inform (nothing-qualifies) prompt', async () => {
    getArchivableSessionCountByAge.mockResolvedValue(okResponse({ data: { archivableCount: 0 } }));
    const { result } = renderHook(() => useBulkArchiveByAge({ refreshProjects, t }));

    await act(async () => {
      await result.current.bulkArchiveSessionsByAge(30);
    });
    expect(result.current.bulkArchiveByAgePrompt?.prompt.kind).toBe('inform');

    await act(async () => {
      await result.current.confirmBulkArchiveByAge();
    });

    expect(bulkArchiveSessionsByAge).not.toHaveBeenCalled();
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  it('confirmBulkArchiveByAge is a no-op when there is no active prompt', async () => {
    const { result } = renderHook(() => useBulkArchiveByAge({ refreshProjects, t }));

    await act(async () => {
      await result.current.confirmBulkArchiveByAge();
    });

    expect(bulkArchiveSessionsByAge).not.toHaveBeenCalled();
    expect(refreshProjects).not.toHaveBeenCalled();
  });
});
