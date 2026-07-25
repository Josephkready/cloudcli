import { cn } from '../../lib/utils';

type SurfaceSkeletonProps = {
  /** Announced to assistive tech while the chunk is in flight. */
  label?: string;
  /**
   * Render as a centred overlay instead of an in-flow pane. Used by the
   * portalled modal surfaces (settings, project wizard) so the click that
   * opened them produces immediate feedback.
   */
  overlay?: boolean;
  className?: string;
};

/**
 * Suspense fallback for a lazily-loaded surface (issue #267).
 *
 * Deliberately layout-shaped rather than a spinner: the pane keeps the same
 * footprint the real surface will occupy, so swapping the chunk in does not
 * reflow the page.
 */
export default function SurfaceSkeleton({
  label = 'Loading…',
  overlay = false,
  className,
}: SurfaceSkeletonProps) {
  const pane = (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(
        'flex h-full w-full flex-col gap-3 overflow-hidden p-4',
        overlay && 'h-auto w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl',
        className,
      )}
    >
      <div className="h-6 w-1/3 animate-pulse rounded bg-muted" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      <div className={cn('animate-pulse rounded-lg bg-muted/60', overlay ? 'h-32' : 'min-h-0 flex-1')} />
      <span className="sr-only">{label}</span>
    </div>
  );

  if (!overlay) {
    return pane;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">{pane}</div>
  );
}
