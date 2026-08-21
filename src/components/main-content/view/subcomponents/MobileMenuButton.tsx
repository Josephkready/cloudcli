import type { MobileMenuButtonProps } from '../../types/types';
import { useMobileMenuHandlers } from '../../hooks/useMobileMenuHandlers';

export default function MobileMenuButton({ onMenuClick, compact = false }: MobileMenuButtonProps) {
  const { handleMobileMenuClick, handleMobileMenuTouchEnd } = useMobileMenuHandlers(onMenuClick);

  // Floor the 32px hamburger to the 44px touch floor (#363), coarse-pointer
  // ::after overlay, no reflow. The compact variant is rendered as the sole
  // child of its own wrapper (MainContentStateView), so it can floor BOTH axes
  // (`hit-44`); the in-header variant sits in a gap-2 row next to the rename
  // target, so it floors height only (`hit-h-44`) to avoid stealing its taps.
  const buttonClasses = compact
    ? 'touch:hit-44 p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-accent/60 pwa-menu-button'
    : 'touch:hit-h-44 p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-accent/60 touch-manipulation active:scale-95 pwa-menu-button flex-shrink-0';

  return (
    <button
      onClick={handleMobileMenuClick}
      onTouchEnd={handleMobileMenuTouchEnd}
      className={buttonClasses}
      aria-label="Open menu"
    >
      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>
  );
}
