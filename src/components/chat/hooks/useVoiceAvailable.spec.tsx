import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VOICE_CONFIG_SYNC_EVENT } from '../../../hooks/useVoiceConfig';

import { useVoiceAvailable } from './useVoiceAvailable';

const mockFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => mockFetch(...args),
}));

function setEnabled(enabled: boolean) {
  localStorage.setItem('uiPreferences', JSON.stringify({ voiceEnabled: enabled }));
}

function setVoiceConfig(baseUrl: string) {
  localStorage.setItem('voiceConfig', JSON.stringify({ baseUrl, apiKey: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' }));
}

beforeEach(() => {
  localStorage.clear();
  mockFetch.mockReset();
});

describe('useVoiceAvailable', () => {
  it('is false when the ui preference is off, without hitting the health check', async () => {
    const { result } = renderHook(() => useVoiceAvailable());
    await waitFor(() => expect(result.current).toBe(false));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is true immediately when a direct backend baseUrl is configured', async () => {
    setEnabled(true);
    setVoiceConfig('https://voice.example.com');

    const { result } = renderHook(() => useVoiceAvailable());

    await waitFor(() => expect(result.current).toBe(true));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('checks server health when enabled with no direct backend', async () => {
    setEnabled(true);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ configured: true }) });

    const { result } = renderHook(() => useVoiceAvailable());

    await waitFor(() => expect(result.current).toBe(true));
    expect(mockFetch).toHaveBeenCalledWith('/api/voice/health');
  });

  it('is false when the health check reports not configured', async () => {
    setEnabled(true);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ configured: false }) });

    const { result } = renderHook(() => useVoiceAvailable());

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('is false when the health check request fails', async () => {
    setEnabled(true);
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() => useVoiceAvailable());

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('reacts to a storage sync event turning the preference on', async () => {
    const { result } = renderHook(() => useVoiceAvailable());
    await waitFor(() => expect(result.current).toBe(false));

    setEnabled(true);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ configured: true }) });
    act(() => window.dispatchEvent(new Event('storage')));

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('re-checks health on the voice-config sync event', async () => {
    setEnabled(true);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ configured: false }) });
    const { result } = renderHook(() => useVoiceAvailable());
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(false);

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ configured: true }) });
    act(() => window.dispatchEvent(new Event(VOICE_CONFIG_SYNC_EVENT)));

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('treats the string "true" from a legacy preference shape as enabled', async () => {
    localStorage.setItem('uiPreferences', JSON.stringify({ voiceEnabled: 'true' }));
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ configured: true }) });

    const { result } = renderHook(() => useVoiceAvailable());

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('treats malformed stored preferences as disabled rather than throwing', async () => {
    localStorage.setItem('uiPreferences', '{not json');

    expect(() => renderHook(() => useVoiceAvailable())).not.toThrow();
  });
});
