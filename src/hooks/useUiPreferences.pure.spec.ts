/**
 * `readInitialPreferences` reads `window`/`localStorage`, so it lives in the
 * vitest (jsdom) suite rather than the node:test one. The reducer and
 * `parseBoolean` are covered without a DOM in `useUiPreferences.pure.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULTS, readInitialPreferences } from './useUiPreferences.pure';

const STORAGE_KEY = 'uiPreferences';

describe('readInitialPreferences', () => {
  it('returns the defaults on a first run', () => {
    expect(readInitialPreferences(STORAGE_KEY)).toEqual(DEFAULTS);
  });

  it('reads the unified preferences blob', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ showRawParameters: true, showThinking: false }),
    );

    expect(readInitialPreferences(STORAGE_KEY)).toEqual({
      ...DEFAULTS,
      showRawParameters: true,
      showThinking: false,
    });
  });

  it('fills missing and uncoercible keys from the defaults', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sidebarVisible: 'nonsense', voiceEnabled: 'true' }),
    );

    const preferences = readInitialPreferences(STORAGE_KEY);
    expect(preferences.sidebarVisible).toBe(DEFAULTS.sidebarVisible);
    expect(preferences.voiceEnabled).toBe(true);
  });

  it('never lets unknown keys into the preference object', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ evil: true, showThinking: false }));

    const preferences = readInitialPreferences(STORAGE_KEY);
    expect(preferences).not.toHaveProperty('evil');
    expect(Object.keys(preferences).sort()).toEqual(Object.keys(DEFAULTS).sort());
  });

  it('migrates the pre-unification per-key entries', () => {
    localStorage.setItem('showRawParameters', 'true');
    localStorage.setItem('sidebarVisible', JSON.stringify(false));

    expect(readInitialPreferences(STORAGE_KEY)).toEqual({
      ...DEFAULTS,
      showRawParameters: true,
      sidebarVisible: false,
    });
  });

  it('falls back to the legacy keys when the unified blob is corrupt', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    localStorage.setItem('showThinking', 'false');

    expect(readInitialPreferences(STORAGE_KEY).showThinking).toBe(false);
  });

  it('falls back to the legacy keys when the unified blob is not an object', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]));
    localStorage.setItem('spacesExpanded', 'true');

    expect(readInitialPreferences(STORAGE_KEY).spacesExpanded).toBe(true);
  });

  it('ignores a legacy value that is not a boolean', () => {
    localStorage.setItem('voiceEnabled', JSON.stringify({ enabled: true }));
    expect(readInitialPreferences(STORAGE_KEY).voiceEnabled).toBe(DEFAULTS.voiceEnabled);
  });

  it('keeps separate storage keys independent', () => {
    localStorage.setItem('other-key', JSON.stringify({ showThinking: false }));
    expect(readInitialPreferences(STORAGE_KEY)).toEqual(DEFAULTS);
    expect(readInitialPreferences('other-key').showThinking).toBe(false);
  });
});
