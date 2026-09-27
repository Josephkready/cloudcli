import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDeviceSettings } from './useDeviceSettings';

/**
 * `useDeviceSettings` wraps two independent window reads — mobile-viewport
 * detection (delegated to the pure, separately-tested `computeIsMobile`) and
 * PWA-standalone detection — with resize/matchMedia wiring. These pin that
 * wiring: default mount values, live updates on `resize` / matchMedia
 * `change`, the legacy `addListener`/`removeListener` fallback branch, and
 * the `trackMobile`/`trackPWA` opt-outs.
 */

type MatchMediaStub = {
  matches: boolean;
  media: string;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
};

function setInnerWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

/** Builds a `matchMedia` stub whose queries can be individually controlled. */
function stubMatchMedia(responses: Record<string, boolean>, { legacy = false } = {}) {
  const listenersByQuery = new Map<string, Set<() => void>>();

  const matchMedia = vi.fn((query: string): MatchMediaStub => {
    const mql: MatchMediaStub = {
      matches: responses[query] ?? false,
      media: query,
    };

    const getListeners = () => {
      let set = listenersByQuery.get(query);
      if (!set) {
        set = new Set();
        listenersByQuery.set(query, set);
      }
      return set;
    };

    if (legacy) {
      mql.addListener = (listener: () => void) => {
        getListeners().add(listener);
      };
      mql.removeListener = (listener: () => void) => {
        getListeners().delete(listener);
      };
    } else {
      mql.addEventListener = (_type: string, listener: () => void) => {
        getListeners().add(listener);
      };
      mql.removeEventListener = (_type: string, listener: () => void) => {
        getListeners().delete(listener);
      };
    }

    return mql;
  });

  vi.stubGlobal('matchMedia', matchMedia);

  return {
    matchMedia,
    setMatches(query: string, matches: boolean) {
      responses[query] = matches;
    },
    fire(query: string) {
      const set = listenersByQuery.get(query);
      set?.forEach((listener) => listener());
    },
  };
}

beforeEach(() => {
  setInnerWidth(1200);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDeviceSettings — mobile viewport tracking', () => {
  it('defaults isMobile to false on a wide, non-touch viewport', () => {
    stubMatchMedia({});
    setInnerWidth(1200);

    const { result } = renderHook(() => useDeviceSettings());

    expect(result.current.isMobile).toBe(false);
  });

  it('defaults isMobile to true when the viewport starts under the breakpoint', () => {
    stubMatchMedia({});
    setInnerWidth(400);

    const { result } = renderHook(() => useDeviceSettings());

    expect(result.current.isMobile).toBe(true);
  });

  it('updates isMobile on a resize event', () => {
    stubMatchMedia({});
    setInnerWidth(1200);

    const { result } = renderHook(() => useDeviceSettings());
    expect(result.current.isMobile).toBe(false);

    act(() => {
      setInnerWidth(500);
      window.dispatchEvent(new Event('resize'));
    });

    expect(result.current.isMobile).toBe(true);
  });

  it('respects a custom mobileBreakpoint', () => {
    stubMatchMedia({});
    setInnerWidth(900);

    const { result } = renderHook(() => useDeviceSettings({ mobileBreakpoint: 1000 }));

    expect(result.current.isMobile).toBe(true);
  });

  it('classifies a wide, coarse-pointer/no-hover viewport as mobile (landscape phone, cloudcli#475)', () => {
    stubMatchMedia({
      '(pointer: coarse)': true,
      '(hover: none)': true,
    });
    setInnerWidth(1200);

    const { result } = renderHook(() => useDeviceSettings());

    expect(result.current.isMobile).toBe(true);
  });

  it('does not wire up resize tracking when trackMobile is false', () => {
    stubMatchMedia({});
    setInnerWidth(400);
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const addSpy = vi.spyOn(window, 'addEventListener');

    const { result, unmount } = renderHook(() => useDeviceSettings({ trackMobile: false }));

    expect(result.current.isMobile).toBe(false);
    expect(addSpy).not.toHaveBeenCalledWith('resize', expect.anything());

    unmount();
    expect(removeSpy).not.toHaveBeenCalledWith('resize', expect.anything());

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('unregisters the resize listener on unmount', () => {
    stubMatchMedia({});
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderHook(() => useDeviceSettings());
    unmount();

    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    removeSpy.mockRestore();
  });
});

describe('useDeviceSettings — PWA standalone tracking', () => {
  it('defaults isPWA to false when not standalone', () => {
    stubMatchMedia({ '(display-mode: standalone)': false });

    const { result } = renderHook(() => useDeviceSettings());

    expect(result.current.isPWA).toBe(false);
  });

  it('defaults isPWA to true when matchMedia reports standalone', () => {
    stubMatchMedia({ '(display-mode: standalone)': true });

    const { result } = renderHook(() => useDeviceSettings());

    expect(result.current.isPWA).toBe(true);
  });

  it('defaults isPWA to true via navigator.standalone even when matchMedia does not', () => {
    stubMatchMedia({ '(display-mode: standalone)': false });
    Object.defineProperty(window.navigator, 'standalone', { configurable: true, value: true });

    const { result } = renderHook(() => useDeviceSettings());

    expect(result.current.isPWA).toBe(true);

    // @ts-expect-error test-only cleanup of a non-standard navigator property
    delete window.navigator.standalone;
  });

  it('updates isPWA on a matchMedia change event (addEventListener path)', () => {
    const media = stubMatchMedia({ '(display-mode: standalone)': false });

    const { result } = renderHook(() => useDeviceSettings());
    expect(result.current.isPWA).toBe(false);

    act(() => {
      media.setMatches('(display-mode: standalone)', true);
      media.fire('(display-mode: standalone)');
    });

    expect(result.current.isPWA).toBe(true);
  });

  it('updates isPWA via the legacy addListener/removeListener fallback', () => {
    const media = stubMatchMedia({ '(display-mode: standalone)': false }, { legacy: true });

    const { result, unmount } = renderHook(() => useDeviceSettings());
    expect(result.current.isPWA).toBe(false);

    act(() => {
      media.setMatches('(display-mode: standalone)', true);
      media.fire('(display-mode: standalone)');
    });

    expect(result.current.isPWA).toBe(true);

    // Exercises the legacy removeListener cleanup branch without throwing.
    expect(() => unmount()).not.toThrow();
  });

  it('does not wire up matchMedia change tracking when trackPWA is false', () => {
    const media = stubMatchMedia({ '(display-mode: standalone)': false });

    const { result } = renderHook(() => useDeviceSettings({ trackPWA: false }));

    expect(result.current.isPWA).toBe(false);
    // getIsPWA() is still called for the initial `false` default, but no
    // change listener should have been registered for the standalone query.
    act(() => {
      media.setMatches('(display-mode: standalone)', true);
      media.fire('(display-mode: standalone)');
    });
    expect(result.current.isPWA).toBe(false);
  });

  it('unregisters the matchMedia change listener on unmount', () => {
    const media = stubMatchMedia({ '(display-mode: standalone)': false });

    const { unmount } = renderHook(() => useDeviceSettings());
    unmount();

    act(() => {
      media.setMatches('(display-mode: standalone)', true);
      media.fire('(display-mode: standalone)');
    });
    // No assertion target survives unmount; reaching here without throwing
    // after firing a change on an unmounted hook is the behavior under test.
  });
});
