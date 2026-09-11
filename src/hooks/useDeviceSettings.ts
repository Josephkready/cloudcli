import { useEffect, useState } from 'react';

import { computeIsMobile } from './isMobileViewport';

type UseDeviceSettingsOptions = {
  mobileBreakpoint?: number;
  trackMobile?: boolean;
  trackPWA?: boolean;
};

// A phone rotated to landscape (e.g. 844x390) is wider than the 768px
// breakpoint, so width alone would put it in the desktop layout (cloudcli#475).
// `computeIsMobile` also treats a coarse-pointer, no-hover device (touch, never
// a mouse) as mobile regardless of width — see its doc comment for why that
// can't regress a real desktop window.
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
