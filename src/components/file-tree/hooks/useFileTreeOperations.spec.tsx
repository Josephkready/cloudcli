import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileTreeNode } from '../types/types';

import { useFileTreeOperations } from './useFileTreeOperations';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

const item = { name: 'file.txt', path: '/workspace/file.txt', type: 'file' } as FileTreeNode;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useFileTreeOperations clipboard handling', () => {
  it('shows success only after the clipboard write resolves', async () => {
    let resolveWrite: (() => void) | undefined;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const showToast = vi.fn();
    const { result } = renderHook(() => useFileTreeOperations({
      selectedProject: null,
      onRefresh: vi.fn(),
      showToast,
    }));

    let copyPromise: Promise<void>;
    act(() => {
      copyPromise = result.current.handleCopyPath(item);
    });
    expect(showToast).not.toHaveBeenCalled();

    await act(async () => {
      resolveWrite?.();
      await copyPromise!;
    });
    expect(showToast).toHaveBeenCalledWith('Path copied to clipboard', 'success');
  });

  it('shows only an error when clipboard access rejects or is unavailable', async () => {
    const showToast = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const { result } = renderHook(() => useFileTreeOperations({
      selectedProject: null,
      onRefresh: vi.fn(),
      showToast,
    }));

    await act(async () => {
      await result.current.handleCopyPath(item);
    });
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Failed to copy path', 'error');

    showToast.mockClear();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await act(async () => {
      await result.current.handleCopyPath(item);
    });
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Failed to copy path', 'error');
  });
});
