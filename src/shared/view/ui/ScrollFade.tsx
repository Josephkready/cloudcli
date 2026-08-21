import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '../../../lib/utils';

import { computeScrollFade, type ScrollFadeState } from './scrollFadeState';

/**
 * Wires {@link computeScrollFade} to a live scroll element.
 *
 * Returns a ref to attach to the scroll viewport plus an `onScroll` handler and
 * the current fade state. A `ResizeObserver` watches both the viewport and its
 * first child, because it is the *content* row's width (a tab added, a label
 * widening) that shifts the fades far more often than the viewport's own box.
 * Pass `resetKey` (e.g. an item count) to force a re-measure when the content
 * changes in a way a resize alone would not catch.
 */
export function useScrollFade<T extends HTMLElement>(resetKey?: unknown) {
  const scrollRef = useRef<T>(null);
  const [state, setState] = useState<ScrollFadeState>({
    canScrollLeft: false,
    canScrollRight: false,
  });

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setState(computeScrollFade(el));
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    onScroll();
    const observer = new ResizeObserver(onScroll);
    observer.observe(el);
    if (el.firstElementChild) {
      observer.observe(el.firstElementChild);
    }
    return () => observer.disconnect();
  }, [onScroll, resetKey]);

  return { scrollRef, onScroll, ...state };
}

type ScrollFadeProps = {
  children: ReactNode;
  /** Classes for the scroll viewport (padding, etc.). */
  className?: string;
  /** Classes for the relative wrapper (sizing within a flex row, etc.). */
  containerClassName?: string;
  /** Re-measure the fades when this value changes (e.g. the item count). */
  resetKey?: unknown;
};

/**
 * A horizontally scrollable region that hides its scrollbar but shows a gradient
 * fade on whichever edge still has content to scroll — the "there's more this
 * way" cue that a bare `scrollbar-hide` row lacks (#360).
 *
 * Children are the row content and should size to their content (e.g. `w-max`)
 * so the viewport, not the row, is what scrolls.
 */
export function ScrollFade({ children, className, containerClassName, resetKey }: ScrollFadeProps) {
  const { scrollRef, onScroll, canScrollLeft, canScrollRight } = useScrollFade<HTMLDivElement>(resetKey);

  return (
    <div className={cn('relative min-w-0', containerClassName)}>
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent transition-opacity duration-fast',
          canScrollLeft ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div ref={scrollRef} onScroll={onScroll} className={cn('scrollbar-hide overflow-x-auto', className)}>
        {children}
      </div>
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent transition-opacity duration-fast',
          canScrollRight ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}
