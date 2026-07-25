import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHideCliOriginChats } from './useHideCliOriginChats';

import { grantClaudeToolPermission } from '@/components/chat/utils/chatPermissions';
import { writeHideCliOriginChats } from '@/components/sidebar/utils/utils';
import { CLAUDE_SETTINGS_KEY, notifyClaudeSettingsChanged } from '@/utils/claudeSettings';

/*
 * #273: this hook used to re-read `claude-settings` from a focus-gated
 * one-second `setInterval` (and it is mounted twice — sidebar list + session tab
 * strip). The poll is gone, so every writer of the blob has to announce itself
 * and this hook has to be listening. Both halves are asserted here: a settings
 * change must land *without any timer advancing*, which is exactly what the old
 * polling implementation could not do.
 */

const writeSettings = (settings: Record<string, unknown>) => {
  window.localStorage.setItem(CLAUDE_SETTINGS_KEY, JSON.stringify(settings));
};

beforeEach(() => {
  // Fake timers everywhere: if anything still relied on a poll, these tests
  // would have to advance the clock to pass.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useHideCliOriginChats — event-driven updates (#273)', () => {
  it('starts from the stored preference and defaults to hiding', () => {
    const { result: withoutSettings } = renderHook(() => useHideCliOriginChats());
    expect(withoutSettings.current).toBe(true);

    writeSettings({ hideCliOriginChats: false });
    const { result: withSettings } = renderHook(() => useHideCliOriginChats());
    expect(withSettings.current).toBe(false);
  });

  it('registers no timers at all', () => {
    const before = vi.getTimerCount();
    renderHook(() => useHideCliOriginChats());

    expect(vi.getTimerCount()).toBe(before);
  });

  it('reflects a settings-dialog write immediately, with no timer advanced', () => {
    const { result } = renderHook(() => useHideCliOriginChats());
    expect(result.current).toBe(true);

    act(() => {
      // What `useSettingsController.saveSettings` does.
      writeSettings({ hideCliOriginChats: false });
      notifyClaudeSettingsChanged();
    });

    expect(result.current).toBe(false);
  });

  it('reflects the sidebar "Show CLI chats" writer immediately', () => {
    const { result } = renderHook(() => useHideCliOriginChats());
    expect(result.current).toBe(true);

    act(() => {
      writeHideCliOriginChats(false);
    });

    expect(result.current).toBe(false);
  });

  it('reflects the chat permission-grant writer, which rewrites the whole blob', () => {
    writeSettings({ hideCliOriginChats: false, allowedTools: [] });
    const { result } = renderHook(() => useHideCliOriginChats());
    expect(result.current).toBe(false);

    act(() => {
      // Merges into the blob it read, so it can also carry a sibling change
      // made elsewhere — the reason this third writer has to notify too.
      window.localStorage.setItem(
        CLAUDE_SETTINGS_KEY,
        JSON.stringify({ hideCliOriginChats: true, allowedTools: [] }),
      );
      grantClaudeToolPermission('Bash(git status:*)');
    });

    expect(result.current).toBe(true);
  });

  it('updates every mounted consumer, not just the first', () => {
    const list = renderHook(() => useHideCliOriginChats());
    const tabs = renderHook(() => useHideCliOriginChats());

    act(() => {
      writeHideCliOriginChats(false);
    });

    expect(list.result.current).toBe(false);
    expect(tabs.result.current).toBe(false);
  });

  it('still follows a write from another tab (native storage event)', () => {
    const { result } = renderHook(() => useHideCliOriginChats());
    expect(result.current).toBe(true);

    act(() => {
      writeSettings({ hideCliOriginChats: false });
      window.dispatchEvent(new StorageEvent('storage', { key: CLAUDE_SETTINGS_KEY }));
    });

    expect(result.current).toBe(false);
  });

  it('ignores a storage event for an unrelated key', () => {
    const { result } = renderHook(() => useHideCliOriginChats());

    act(() => {
      writeSettings({ hideCliOriginChats: false });
      window.dispatchEvent(new StorageEvent('storage', { key: 'codex-settings' }));
    });

    expect(result.current).toBe(true);
  });

  it('detaches both listeners on unmount', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderHook(() => useHideCliOriginChats());
    const registrations = added.mock.calls.filter(
      ([type]) => type === 'storage' || type === 'claudeSettingsChanged',
    );
    expect(registrations).toHaveLength(2);

    unmount();

    for (const [type, handler] of registrations) {
      expect(removed).toHaveBeenCalledWith(type, handler);
    }

    added.mockRestore();
    removed.mockRestore();
  });

  it('stops reacting to writes once unmounted', () => {
    const { result, unmount } = renderHook(() => useHideCliOriginChats());
    expect(result.current).toBe(true);

    unmount();
    act(() => {
      writeHideCliOriginChats(false);
    });

    // A leaked listener would keep setting state on an unmounted hook.
    expect(result.current).toBe(true);
  });
});
