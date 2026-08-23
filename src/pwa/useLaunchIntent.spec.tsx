import { renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SHARED_TEXT_KEY } from './launchParams';
import { useLaunchIntent } from './useLaunchIntent';

/**
 * Acting on the URL an installed app was launched with (issue #370).
 *
 * Every behaviour here fails silently when it breaks — a shortcut that does
 * nothing, a share that vanishes, or an intent that re-fires on every reload —
 * so none of it is safe to leave to inspection.
 */

const ORIGINAL_URL = 'http://localhost:3000/';

/**
 * Point `window.location` at a URL without navigating.
 *
 * Clears the spy afterwards: this helper drives `replaceState` itself, and
 * without the reset the assertions about whether the HOOK stripped the URL would
 * be counting the test's own setup call.
 */
function setUrl(url: string): void {
  window.history.replaceState(null, '', url);
  replaceState?.mockClear();
}

let replaceState: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  setUrl(ORIGINAL_URL);
  replaceState = vi.spyOn(window.history, 'replaceState');
});

afterEach(() => {
  replaceState.mockRestore();
  localStorage.clear();
  setUrl(ORIGINAL_URL);
});

describe('the New conversation shortcut', () => {
  it('starts a conversation when a project is already available', () => {
    setUrl('/?new=1');
    const start = vi.fn();

    renderHook(() => useLaunchIntent(start));

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does nothing on an ordinary launch', () => {
    const start = vi.fn();
    renderHook(() => useLaunchIntent(start));
    expect(start).not.toHaveBeenCalled();
  });

  it('holds the action until a project exists, rather than dropping it', () => {
    // A cold launch from the home screen reaches this before the project list
    // has loaded. Dropping the intent there would make the shortcut do nothing
    // precisely when it is most likely to be used.
    setUrl('/?new=1');
    const start = vi.fn();

    const view = renderHook(
      ({ ready }: { ready: boolean }) => useLaunchIntent(ready ? start : null),
      { initialProps: { ready: false } },
    );
    expect(start).not.toHaveBeenCalled();

    view.rerender({ ready: true });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('fires once even though the callback identity changes every render', () => {
    setUrl('/?new=1');
    const start = vi.fn();

    // The caller passes an inline arrow, so a new function arrives on every
    // render. Without the latch this would restart the conversation forever.
    const view = renderHook(() => useLaunchIntent(() => start()));
    view.rerender();
    view.rerender();

    expect(start).toHaveBeenCalledTimes(1);
  });

  // React double-invokes mount effects under StrictMode, and this hook strips
  // the URL. Parsing inside the effect meant the second invocation read an
  // already-stripped URL and wiped the intent, so the shortcut silently did
  // nothing in dev.
  it('survives StrictMode double-invoking the mount effect', () => {
    setUrl('/?new=1');
    const start = vi.fn();

    const view = renderHook(
      ({ ready }: { ready: boolean }) => useLaunchIntent(ready ? start : null),
      {
        initialProps: { ready: false },
        wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
      },
    );
    view.rerender({ ready: true });

    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('a share arriving from another app', () => {
  it('parks the shared text for the composer to claim', () => {
    setUrl('/?share_text=hello%20from%20elsewhere');

    renderHook(() => useLaunchIntent(null));

    expect(localStorage.getItem(SHARED_TEXT_KEY)).toBe('hello from elsewhere');
  });

  it('parks a shared link', () => {
    setUrl('/?share_url=https%3A%2F%2Fexample.com%2Fa');
    renderHook(() => useLaunchIntent(null));
    expect(localStorage.getItem(SHARED_TEXT_KEY)).toBe('https://example.com/a');
  });

  it('parks nothing on an ordinary launch', () => {
    renderHook(() => useLaunchIntent(null));
    expect(localStorage.getItem(SHARED_TEXT_KEY)).toBeNull();
  });
});

describe('one-shot cleanup', () => {
  it('strips the launch parameters from the address bar', () => {
    setUrl('/?new=1&share_text=hi');

    renderHook(() => useLaunchIntent(null));

    // A reload must not repeat the intent — resetting a conversation the user
    // has moved on from, or re-inserting a share they already sent.
    expect(replaceState).toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it('leaves unrelated query parameters alone', () => {
    setUrl('/?tab=files&new=1');

    renderHook(() => useLaunchIntent(null));

    expect(window.location.search).toBe('?tab=files');
  });

  it('does not touch the URL when there is no intent to strip', () => {
    setUrl('/?tab=files');

    renderHook(() => useLaunchIntent(null));

    expect(replaceState).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?tab=files');
  });
});
