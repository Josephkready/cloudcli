import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderModelsCacheInfo } from '../../../types/app';

import { useChatProviderState } from './useChatProviderState';

const { authenticatedFetch, recordFeatureUse } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  recordFeatureUse: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({ authenticatedFetch }));
vi.mock('../../../utils/featureUsage', () => ({ recordFeatureUse }));

const modelDefinitions = {
  claude: {
    DEFAULT: 'sonnet',
    OPTIONS: [{ value: 'sonnet', label: 'Sonnet', effort: { values: [{ value: 'high' }] } }],
  },
  codex: {
    DEFAULT: 'gpt-test',
    OPTIONS: [{ value: 'gpt-test', label: 'GPT Test', effort: { values: [{ value: 'high' }] } }],
  },
  antigravity: {
    DEFAULT: 'gemini-test',
    OPTIONS: [
      { value: 'gemini-test', label: 'Gemini Test' },
      { value: 'gemini-alt', label: 'Gemini Alt' },
    ],
  },
};

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

async function providerApi(input: string, init?: RequestInit): Promise<Response> {
  const modelMatch = input.match(/^\/api\/providers\/(claude|codex|antigravity)\/models/);
  if (modelMatch) {
    const provider = modelMatch[1] as keyof typeof modelDefinitions;
    return jsonResponse({
      success: true,
      data: {
        models: modelDefinitions[provider],
        cache: {
          source: 'fresh',
          updatedAt: '2026-07-28T00:00:00.000Z',
          expiresAt: '2026-07-31T00:00:00.000Z',
        } satisfies ProviderModelsCacheInfo,
      },
    });
  }
  if (input === '/api/providers/capabilities') {
    return jsonResponse({
      success: true,
      data: {
        providers: [
          { provider: 'claude', permissionModes: ['default'], defaultPermissionMode: 'default', supportsEffort: true },
          { provider: 'codex', permissionModes: ['default'], defaultPermissionMode: 'default', supportsEffort: true },
          { provider: 'antigravity', permissionModes: ['default', 'plan'], defaultPermissionMode: 'default', supportsEffort: false },
        ],
      },
    });
  }
  if (
    input === '/api/providers/antigravity/sessions/agy-app-session/active-model'
    && init?.method === 'POST'
  ) {
    return jsonResponse({
      success: true,
      data: {
        provider: 'antigravity',
        sessionId: 'agy-app-session',
        supported: true,
        changed: true,
        model: 'gemini-alt',
      },
    });
  }
  throw new Error(`Unexpected request: ${input}`);
}

beforeEach(() => {
  authenticatedFetch.mockReset();
  recordFeatureUse.mockReset();
  localStorage.clear();
  localStorage.setItem('selected-provider', 'antigravity');
  authenticatedFetch.mockImplementation(providerApi);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useChatProviderState — Antigravity selectors', () => {
  it('resets stale effort and exposes no effort options for Antigravity', async () => {
    localStorage.setItem('antigravity-effort', 'high');
    const { result } = renderHook(() => useChatProviderState({
      selectedSession: null,
      selectedProject: null,
    }));

    await waitFor(() => expect(result.current.providerModelsLoading).toBe(false));
    await waitFor(() => expect(localStorage.getItem('antigravity-effort')).toBe('default'));

    expect(result.current.provider).toBe('antigravity');
    expect(result.current.currentProviderEffort).toBe('default');
    expect(result.current.currentProviderEffortOptions).toEqual([]);
  });

  it('keeps effort disabled when provider capabilities cannot be loaded', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem('antigravity-effort', 'high');
    authenticatedFetch.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/providers/capabilities') {
        throw new Error('capabilities unavailable');
      }
      return providerApi(input, init);
    });

    const { result } = renderHook(() => useChatProviderState({
      selectedSession: null,
      selectedProject: null,
    }));

    await waitFor(() => expect(result.current.providerModelsLoading).toBe(false));
    await waitFor(() => expect(localStorage.getItem('antigravity-effort')).toBe('default'));

    expect(result.current.currentProviderEffort).toBe('default');
    expect(result.current.currentProviderEffortOptions).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      'Error loading provider capabilities:',
      expect.any(Error),
    );
  });

  it('replaces a stale stored Antigravity model with the catalog default', async () => {
    localStorage.setItem('antigravity-model', 'gemini-removed');
    const { result } = renderHook(() => useChatProviderState({
      selectedSession: null,
      selectedProject: null,
    }));

    await waitFor(() => expect(result.current.providerModelsLoading).toBe(false));
    await waitFor(() => expect(result.current.antigravityModel).toBe('gemini-test'));

    expect(localStorage.getItem('antigravity-model')).toBe('gemini-test');
  });

  it('does not mutate the default model when an in-session model change is rejected', async () => {
    localStorage.setItem('antigravity-model', 'gemini-test');
    authenticatedFetch.mockImplementation(async (input: string, init?: RequestInit) => {
      if (
        input === '/api/providers/antigravity/sessions/agy-app-session/active-model'
        && init?.method === 'POST'
      ) {
        return jsonResponse({
          success: true,
          data: {
            provider: 'antigravity',
            sessionId: 'agy-app-session',
            supported: false,
            changed: false,
          },
        });
      }
      return providerApi(input, init);
    });

    const { result } = renderHook(() => useChatProviderState({
      selectedSession: null,
      selectedProject: null,
    }));
    await waitFor(() => expect(result.current.providerModelsLoading).toBe(false));

    await expect(result.current.selectProviderModel(
      'antigravity',
      'gemini-alt',
      'agy-app-session',
    )).rejects.toThrow('Unable to change the active model');
    expect(result.current.antigravityModel).toBe('gemini-test');
    expect(localStorage.getItem('antigravity-model')).toBe('gemini-test');
  });

  it('persists a pre-session model and posts an in-session Antigravity model change', async () => {
    const { result } = renderHook(() => useChatProviderState({
      selectedSession: null,
      selectedProject: null,
    }));
    await waitFor(() => expect(result.current.providerModelsLoading).toBe(false));

    await act(async () => {
      await result.current.selectProviderModel('antigravity', 'gemini-alt');
    });
    expect(result.current.antigravityModel).toBe('gemini-alt');
    expect(localStorage.getItem('antigravity-model')).toBe('gemini-alt');

    await act(async () => {
      await result.current.selectProviderModel(
        'antigravity',
        'gemini-alt',
        'agy-app-session',
      );
    });

    expect(authenticatedFetch).toHaveBeenCalledWith(
      '/api/providers/antigravity/sessions/agy-app-session/active-model',
      {
        method: 'POST',
        body: JSON.stringify({ model: 'gemini-alt' }),
      },
    );
    expect(recordFeatureUse).toHaveBeenCalledWith('chat.model_change');
  });
});
