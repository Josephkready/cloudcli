import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();

vi.mock('@/utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const { useProviderAuthStatus } = await import('./useProviderAuthStatus');

const jsonResponse = (payload: unknown, ok = true) => ({
  ok,
  json: async () => payload,
}) as unknown as Response;

beforeEach(() => {
  authenticatedFetch.mockReset();
});

describe('useProviderAuthStatus', () => {
  it('starts every provider in the loading state by default', () => {
    const { result } = renderHook(() => useProviderAuthStatus());
    expect(result.current.providerAuthStatus.claude.loading).toBe(true);
    expect(result.current.providerAuthStatus.codex.loading).toBe(true);
    expect(result.current.providerAuthStatus.antigravity.loading).toBe(true);
  });

  it('honors initialLoading: false', () => {
    const { result } = renderHook(() => useProviderAuthStatus({ initialLoading: false }));
    expect(result.current.providerAuthStatus.claude.loading).toBe(false);
  });

  it('checkProviderAuthStatus stores an authenticated status from a successful response', async () => {
    authenticatedFetch.mockResolvedValue(
      jsonResponse({ success: true, data: { authenticated: true, email: 'jo@example.com', method: 'oauth' } }),
    );
    const { result } = renderHook(() => useProviderAuthStatus());

    let status;
    await act(async () => {
      status = await result.current.checkProviderAuthStatus('claude');
    });

    expect(status).toEqual({
      authenticated: true,
      email: 'jo@example.com',
      method: 'oauth',
      error: null,
      loading: false,
    });
    expect(result.current.providerAuthStatus.claude).toEqual(status);
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/providers/claude/auth/status');
  });

  it('records a not-authenticated status with a fallback error when the response is not ok', async () => {
    authenticatedFetch.mockResolvedValue(jsonResponse({}, false));
    const { result } = renderHook(() => useProviderAuthStatus());

    await act(async () => {
      await result.current.checkProviderAuthStatus('codex');
    });

    expect(result.current.providerAuthStatus.codex).toEqual({
      authenticated: false,
      email: null,
      method: null,
      error: 'Failed to check authentication status',
      loading: false,
    });
  });

  it('records the caught error message when the fetch rejects', async () => {
    authenticatedFetch.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useProviderAuthStatus());

    await act(async () => {
      await result.current.checkProviderAuthStatus('antigravity');
    });

    expect(result.current.providerAuthStatus.antigravity).toEqual({
      authenticated: false,
      email: null,
      method: null,
      error: 'network down',
      loading: false,
    });
  });

  it('falls back to a generic message when a non-Error value is thrown', async () => {
    authenticatedFetch.mockRejectedValue('boom');
    const { result } = renderHook(() => useProviderAuthStatus());

    await act(async () => {
      await result.current.checkProviderAuthStatus('claude');
    });

    expect(result.current.providerAuthStatus.claude.error).toBe('Unknown error');
  });

  it('sets loading true synchronously while a check is in flight', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    authenticatedFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { result } = renderHook(() => useProviderAuthStatus({ initialLoading: false }));

    let pending: Promise<unknown>;
    act(() => {
      pending = result.current.checkProviderAuthStatus('claude');
    });

    expect(result.current.providerAuthStatus.claude.loading).toBe(true);
    expect(result.current.providerAuthStatus.claude.error).toBeNull();

    await act(async () => {
      resolveFetch(jsonResponse({ success: true, data: { authenticated: false } }));
      await pending;
    });

    expect(result.current.providerAuthStatus.claude.loading).toBe(false);
  });

  it('refreshProviderAuthStatuses checks all CLI providers by default', async () => {
    authenticatedFetch.mockResolvedValue(
      jsonResponse({ success: true, data: { authenticated: true } }),
    );
    const { result } = renderHook(() => useProviderAuthStatus());

    await act(async () => {
      await result.current.refreshProviderAuthStatuses();
    });

    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/providers/claude/auth/status');
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/providers/codex/auth/status');
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/providers/antigravity/auth/status');
    await waitFor(() => expect(result.current.providerAuthStatus.claude.authenticated).toBe(true));
  });

  it('refreshProviderAuthStatuses can target a subset of providers', async () => {
    authenticatedFetch.mockResolvedValue(
      jsonResponse({ success: true, data: { authenticated: true } }),
    );
    const { result } = renderHook(() => useProviderAuthStatus());

    await act(async () => {
      await result.current.refreshProviderAuthStatuses(['codex']);
    });

    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/providers/codex/auth/status');
  });
});
