import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';

/* ── Container ─────────────────────────────────────────────────── */
type PillBarProps = {
  children: ReactNode;
  className?: string;
};

export function PillBar({ children, className }: PillBarProps) {
  return (
    <div className={cn('inline-flex items-center gap-[2px] rounded-lg bg-muted/60 p-[3px]', className)}>
      {children}
    </div>
  );
}

/* ── Individual pill button ────────────────────────────────────── */
type PillProps = {
  isActive: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
};

export function Pill({ isActive, onClick, children, className }: PillProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        // `touch:hit-h-44` floors the touch height at 44px via a transparent
        // ::after overlay (coarse-pointer only, no reflow) — pills render as
        // short as 24px in the primary tab bar, below the repo's touch floor
        // (#363). Height-only because PillBar is a gap-[2px] row where a 44px
        // wide overlay would steal taps from the neighbouring pill.
        'touch:hit-h-44 flex touch-manipulation items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-[color,background-color,box-shadow] duration-fast',
        isActive
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground active:bg-background/50',
        className,
      )}
    >
      {children}
    </button>
  );
}
