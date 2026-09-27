import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CODE_EDITOR_DEFAULTS,
  CODE_EDITOR_SETTINGS_CHANGED_EVENT,
  CODE_EDITOR_STORAGE_KEYS,
} from '../constants/settings';
import { useCodeEditorSettings } from './useCodeEditorSettings';

type Settings = ReturnType<typeof useCodeEditorSettings>;

let settings: Settings;

function Harness() {
  settings = useCodeEditorSettings();
  return null;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('useCodeEditorSettings', () => {
  it('falls back to the documented defaults when storage is empty', () => {
    render(<Harness />);

    expect(settings.wordWrap).toBe(false);
    expect(settings.minimapEnabled).toBe(CODE_EDITOR_DEFAULTS.minimapEnabled);
    expect(settings.showLineNumbers).toBe(CODE_EDITOR_DEFAULTS.showLineNumbers);
    expect(settings.fontSize).toBe(Number(CODE_EDITOR_DEFAULTS.fontSize));
  });

  it('reads pre-existing values out of localStorage on mount', () => {
    localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.wordWrap, 'true');
    localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.showMinimap, 'false');
    localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.lineNumbers, 'false');
    localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.fontSize, '18');

    render(<Harness />);

    expect(settings.wordWrap).toBe(true);
    expect(settings.minimapEnabled).toBe(false);
    expect(settings.showLineNumbers).toBe(false);
    expect(settings.fontSize).toBe(18);
  });

  it('persists wordWrap to localStorage whenever it changes', () => {
    render(<Harness />);

    act(() => settings.setWordWrap(true));

    expect(localStorage.getItem(CODE_EDITOR_STORAGE_KEYS.wordWrap)).toBe('true');
  });

  it('re-reads every setting from storage on a "storage" event', () => {
    render(<Harness />);

    localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.wordWrap, 'true');
    localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.showMinimap, 'false');
    localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.lineNumbers, 'false');
    localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.fontSize, '20');

    act(() => {
      window.dispatchEvent(new Event('storage'));
    });

    expect(settings.wordWrap).toBe(true);
    expect(settings.minimapEnabled).toBe(false);
    expect(settings.showLineNumbers).toBe(false);
    expect(settings.fontSize).toBe(20);
  });

  it('re-reads every setting from storage on the app-local settings-changed event', () => {
    render(<Harness />);

    localStorage.setItem(CODE_EDITOR_STORAGE_KEYS.showMinimap, 'false');

    act(() => {
      window.dispatchEvent(new Event(CODE_EDITOR_SETTINGS_CHANGED_EVENT));
    });

    expect(settings.minimapEnabled).toBe(false);
  });

  it('exposes direct setters for minimap, line numbers and font size', () => {
    render(<Harness />);

    act(() => {
      settings.setMinimapEnabled(false);
      settings.setShowLineNumbers(false);
      settings.setFontSize(24);
    });

    expect(settings.minimapEnabled).toBe(false);
    expect(settings.showLineNumbers).toBe(false);
    expect(settings.fontSize).toBe(24);
  });

  it('removes its window listeners on unmount', () => {
    const { unmount } = render(<Harness />);
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('storage', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith(CODE_EDITOR_SETTINGS_CHANGED_EVENT, expect.any(Function));
  });
});
