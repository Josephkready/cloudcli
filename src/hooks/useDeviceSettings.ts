import { useEffect, useState } from 'react';

import { computeIsMobile } from './isMobileViewport';

type UseDeviceSettingsOptions = {
  mobileBreakpoint?: number;
  trackMobile?: boolean;
  trackPWA?: boolean;
};

/**
 * Tracks two independent pieces of device state the app's layout branches on:
 * whether this is a "mobile" viewport (drives the sidebar-vs-overlay and
 * composer layout), and whether the app is running installed as a PWA (drives
 * safe-area padding and install-flow gating). Kept in one hook because both
 * are cheap `window`/`matchMedia` reads that want the same resize/lifecycle
 * wiring, not because they're related to each other.
 *
 * ## Mobile detection (cloudcli#475)
 *
 * `getIsMobile` used to be `window.innerWidth < mobileBreakpoint` alone. A
 * phone rotated to landscape (e.g. 844x390, an iPhone 14) is *wider* than the
 * 768px breakpoint, so that check alone put it in the desktop layout — a
 * fixed sidebar, and a chat composer with no keyboard/short-viewport height
 * awareness, on a device that is still a phone.
 *
 * The fix, delegated to the pure {@link computeIsMobile} (see its doc comment
 * for the full reasoning): width still decides the common case, but a
 * coarse-pointer/no-hover device — touch, never a mouse — is also mobile
 * regardless of width. No real desktop or laptop satisfies both signals at
 * once, so this can only ever *add* landscape phones/tablets to the mobile
 * bucket; it cannot misclassify a mouse-driven session no matter how the
 * window is resized or shaped.
 *
 * `matchMedia` is guarded the same way the rest of this file already guards
 * `window` (SSR, or a test environment without it) — silently falling back
 * to `false` rather than throwing, consistent with `getIsPWA` below and with
 * `keyboardViewport.ts`'s environment guards elsewhere in the app.
 */
const getIsMobile = (mobileBreakpoint: number): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return computeIsMobile(
    {
      width: window.innerWidth,
      isCoarsePointer: typeof window.matchMedia === 'function'
        ? window.matchMedia('(pointer: coarse)').matches
        : false,
      hasNoHover: typeof window.matchMedia === 'function'
        ? window.matchMedia('(hover: none)').matches
        : false,
    },
    mobileBreakpoint,
  );
};

const getIsPWA = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean(navigatorWithStandalone.standalone) ||
    document.referrer.includes('android-app://')
  );
};

export function useDeviceSettings(options: UseDeviceSettingsOptions = {}) {
  const {
    mobileBreakpoint = 768,
    trackMobile = true,
    trackPWA = true
  } = options;

  const [isMobile, setIsMobile] = useState<boolean>(() => (
    trackMobile ? getIsMobile(mobileBreakpoint) : false
  ));
  const [isPWA, setIsPWA] = useState<boolean>(() => (
    trackPWA ? getIsPWA() : false
  ));

  useEffect(() => {
    if (!trackMobile || typeof window === 'undefined') {
      return;
    }

    const checkMobile = () => {
      setIsMobile(getIsMobile(mobileBreakpoint));
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => {
      window.removeEventListener('resize', checkMobile);
    };
  }, [mobileBreakpoint, trackMobile]);

  useEffect(() => {
    if (!trackPWA || typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const checkPWA = () => {
      setIsPWA(getIsPWA());
    };

    checkPWA();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', checkPWA);
      return () => {
        mediaQuery.removeEventListener('change', checkPWA);
      };
    }

    mediaQuery.addListener(checkPWA);
    return () => {
      mediaQuery.removeListener(checkPWA);
    };
  }, [trackPWA]);

  return { isMobile, isPWA };
}
