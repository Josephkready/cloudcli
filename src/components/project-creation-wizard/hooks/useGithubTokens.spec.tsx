import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchGithubTokenCredentials = vi.fn();

vi.mock('../data/workspaceApi', () => ({
  fetchGithubTokenCredentials: (...args: unknown[]) => fetchGithubTokenCredentials(...args),
}));

const { useGithubTokens } = await import('./useGithubTokens');

beforeEach(() => {
  fetchGithubTokenCredentials.mockReset();
});

describe('useGithubTokens', () => {
  it('does not fetch when shouldLoad is false', () => {
    const onAutoSelectToken = vi.fn();
    renderHook(() =>
      useGithubTokens({ shouldLoad: false, selectedTokenId: '', onAutoSelectToken }),
    );

    expect(fetchGithubTokenCredentials).not.toHaveBeenCalled();
  });

  it('loads tokens and auto-selects the first one when none is selected', async () => {
    const tokens = [
      { id: 1, credential_name: 'work', is_active: true },
      { id: 2, credential_name: 'personal', is_active: true },
    ];
    fetchGithubTokenCredentials.mockResolvedValue(tokens);
    const onAutoSelectToken = vi.fn();

    const { result } = renderHook(() =>
      useGithubTokens({ shouldLoad: true, selectedTokenId: '', onAutoSelectToken }),
    );

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tokens).toEqual(tokens);
    expect(onAutoSelectToken).toHaveBeenCalledWith('1');
    expect(result.current.loadError).toBeNull();
  });

  it('does not auto-select when a token is already selected', async () => {
    const tokens = [{ id: 1, credential_name: 'work', is_active: true }];
    fetchGithubTokenCredentials.mockResolvedValue(tokens);
    const onAutoSelectToken = vi.fn();

    const { result } = renderHook(() =>
      useGithubTokens({ shouldLoad: true, selectedTokenId: '1', onAutoSelectToken }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(onAutoSelectToken).not.toHaveBeenCalled();
    expect(result.current.selectedTokenName).toBe('work');
  });

  it('surfaces a load error message', async () => {
    fetchGithubTokenCredentials.mockRejectedValue(new Error('network down'));
    const onAutoSelectToken = vi.fn();

    const { result } = renderHook(() =>
      useGithubTokens({ shouldLoad: true, selectedTokenId: '', onAutoSelectToken }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.loadError).toBe('network down');
    expect(result.current.tokens).toEqual([]);
  });

  it('falls back to a generic error message for a non-Error rejection', async () => {
    fetchGithubTokenCredentials.mockRejectedValue('boom');
    const onAutoSelectToken = vi.fn();

    const { result } = renderHook(() =>
      useGithubTokens({ shouldLoad: true, selectedTokenId: '', onAutoSelectToken }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.loadError).toBe('Failed to load GitHub tokens');
  });

  it('only loads once even if shouldLoad stays true across rerenders', async () => {
    fetchGithubTokenCredentials.mockResolvedValue([]);
    const onAutoSelectToken = vi.fn();

    const { result, rerender } = renderHook(
      (props: { selectedTokenId: string }) =>
        useGithubTokens({ shouldLoad: true, selectedTokenId: props.selectedTokenId, onAutoSelectToken }),
      { initialProps: { selectedTokenId: '' } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => rerender({ selectedTokenId: 'abc' }));

    expect(fetchGithubTokenCredentials).toHaveBeenCalledTimes(1);
  });

  it('returns null selectedTokenName when no token matches', async () => {
    fetchGithubTokenCredentials.mockResolvedValue([
      { id: 5, credential_name: 'other', is_active: true },
    ]);
    const onAutoSelectToken = vi.fn();

    const { result } = renderHook(() =>
      useGithubTokens({ shouldLoad: true, selectedTokenId: '999', onAutoSelectToken }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.selectedTokenName).toBeNull();
  });
});
