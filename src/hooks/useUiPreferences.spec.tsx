import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useUiPreferences } from './useUiPreferences';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('useUiPreferences storage failures', () => {
  it('keeps preference updates in memory when localStorage writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    const { result } = renderHook(() => useUiPreferences('blocked-preferences'));
    act(() => {
      result.current.setPreference('showThinking', false);
    });

    expect(result.current.preferences.showThinking).toBe(false);
  });
});
