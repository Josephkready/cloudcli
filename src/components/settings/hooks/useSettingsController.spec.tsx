import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();

vi.mock('@/utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  api: {},
  isValidRefreshedToken: () => false,
}));

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => {} }),
}));

const { useSettingsController } = await import('./useSettingsController');

/*
 * #232: merely opening Settings performed a real save — it wrote localStorage,
 * issued PUT /api/settings/notification-preferences and flashed "Settings saved
 * successfully!". The old guard was a single-shot boolean, but `saveSettings`
 * is a useCallback over ~10 pieces of asynchronously-loaded state, so it takes
 * on several identities during the open sequence and the boolean only skipped
 * the first pass. The auto-save is now gated on an actual user edit.
 */

type Controller = ReturnType<typeof useSettingsController>;

let controller: Controller;

function Harness({ isOpen }: { isOpen: boolean }) {
  controller = useSettingsController({ isOpen, initialTab: 'agents' });
  return <div data-testid="status">{controller.saveStatus ?? 'idle'}</div>;
}

const notificationWrites = () => authenticatedFetch.mock.calls.filter(
  ([url, options]) => String(url).includes('/api/settings/notification-preferences')
    && (options as { method?: string } | undefined)?.method === 'PUT',
);

beforeEach(() => {
  authenticatedFetch.mockReset();
  // A deliberately *late* notification-preferences load: this is what gave
  // `saveSettings` a second identity after the one-shot boolean was consumed.
  authenticatedFetch.mockImplementation((url: string) => {
    if (String(url).includes('/api/settings/notification-preferences')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          preferences: {
            channels: { inApp: true, webPush: true, sound: false },
            events: { actionRequired: true, stop: false, error: true },
          },
        }),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ success: true, data: { authenticated: false } }),
    } as unknown as Response);
  });
});

describe('useSettingsController — auto-save gating (#232)', () => {
  it('opening Settings performs no save and shows no success toast', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness isOpen />);

    // Let the async loads settle, then run well past the 500ms debounce.
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(notificationWrites()).toHaveLength(0);
    expect(window.localStorage.getItem('claude-settings')).toBeNull();
    expect(screen.getByTestId('status')).toHaveTextContent('idle');
  });

  it('still auto-saves once the user actually changes a setting', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness isOpen />);

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(notificationWrites()).toHaveLength(0);

    act(() => {
      controller.setProjectSortOrder('name');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(notificationWrites()).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('success'));
    expect(window.localStorage.getItem('claude-settings')).toContain('"projectSortOrder":"name"');
  });

  it('does not write back a stale slice while an async load is still in flight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness isOpen />);

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // The loaded preferences differ from the hook's defaults; without the fix
    // the open-time save would have persisted whichever slice happened to be
    // resolved at that instant.
    expect(controller.notificationPreferences.channels.webPush).toBe(true);
    expect(controller.notificationPreferences.channels.sound).toBe(false);
    expect(notificationWrites()).toHaveLength(0);
  });

  it('treats a reopened dialog as clean again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender } = render(<Harness isOpen />);

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    act(() => {
      controller.setCodexPermissionMode('acceptEdits');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(notificationWrites()).toHaveLength(1);

    rerender(<Harness isOpen={false} />);
    rerender(<Harness isOpen />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // Reopening on its own must not produce a second write.
    expect(notificationWrites()).toHaveLength(1);
  });
});
