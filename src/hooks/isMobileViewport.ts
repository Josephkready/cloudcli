/**
 * The pure "is this a mobile layout" decision, extracted from
 * {@link ../hooks/useDeviceSettings} so it is testable without a DOM
 * (cloudcli#475).
 *
 * ## The bug this replaces
 *
 * `useDeviceSettings` used to decide mobile-vs-desktop from `window.innerWidth`
 * alone: `innerWidth < mobileBreakpoint` (768px). That is correct for a phone
 * held upright, but a phone rotated to landscape is 844px wide (iPhone 14) —
 * comfortably past the breakpoint — while still being exactly the device the
 * mobile composer, mobile sidebar overlay and touch-sized controls exist for.
 * The app fell back to the desktop layout in that orientation: a fixed sidebar
 * competing for width, and — the more serious half of cloudcli#475 — a
 * composer with no mobile-aware height bound, which is what let a soft
 * keyboard or a long message push the send button off-screen.
 *
 * ## The fix
 *
 * Width alone cannot distinguish "phone in landscape" from "a genuinely wide
 * screen" — both are wider than 768px. What *does* distinguish them is input
 * capability: `(pointer: coarse)` is true only for touch input (never a mouse),
 * and `(hover: none)` is true only when the primary input cannot hover (never
 * a mouse, and not usually a trackpad). No real desktop or laptop — the case
 * this must never regress — matches both at once, so ORing this onto the width
 * check only ever *adds* landscape phones/tablets to the mobile bucket; it
 * cannot flip a mouse-driven session into the mobile layout no matter how
 * narrow or short its window is resized.
 *
 * Deliberately not "the shorter viewport dimension" (the other option this
 * issue considered): a real laptop with a shallow window (e.g. 1400x600) would
 * misclassify as mobile under that rule, which is exactly the desktop
 * regression this fix must avoid. Pointer/hover capability doesn't have that
 * failure mode — it doesn't look at the window's shape at all.
 */
export interface MobileViewportEnvironment {
  /** `window.innerWidth`. */
  width: number;
  /** `matchMedia('(pointer: coarse)').matches` — true only for touch input. */
  isCoarsePointer: boolean;
  /** `matchMedia('(hover: none)').matches` — true only when nothing can hover. */
  hasNoHover: boolean;
}

export function computeIsMobile(
  env: MobileViewportEnvironment,
  mobileBreakpoint: number,
): boolean {
  if (env.width < mobileBreakpoint) {
    return true;
  }

  // A touch device with no hover capability is a phone or tablet regardless of
  // how wide its viewport is (cloudcli#475's landscape phone). A mouse/trackpad
  // desktop session never satisfies both, so this branch cannot fire for it.
  return env.isCoarsePointer && env.hasNoHover;
}
