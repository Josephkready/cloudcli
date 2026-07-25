import { Suspense, lazy, useCallback, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';

import ErrorBoundary from '../main-content/view/ErrorBoundary';

import SurfaceSkeleton from './SurfaceSkeleton';
import { loadWithRetry } from './lazySurface.pure';

const CHUNK_ERROR_DESCRIPTION =
  'This part of the app could not be loaded. Check your connection and reload the page.';

/**
 * `React.lazy` with the app's chunk-loading policy applied (issue #267).
 *
 * Always pair the returned component with `<LazySurface>` (or another
 * `Suspense` + error boundary) so a chunk that never arrives degrades to a
 * message instead of an unmounted app.
 */
export function lazySurface<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() => loadWithRetry(load));
}

type LazySurfaceProps = {
  children: ReactNode;
  /** Shown while the chunk is in flight. Pass `null` to render nothing. */
  fallback?: ReactNode;
};

/**
 * Suspense + error boundary wrapper for a lazily-loaded surface.
 *
 * The retry action reloads the document rather than re-rendering: `React.lazy`
 * memoises a rejected factory, so once a chunk has failed for good the only way
 * back is a fresh document.
 */
export default function LazySurface({ children, fallback }: LazySurfaceProps) {
  const handleRetry = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, []);

  return (
    <ErrorBoundary description={CHUNK_ERROR_DESCRIPTION} retryLabel="Reload" onRetry={handleRetry}>
      <Suspense fallback={fallback === undefined ? <SurfaceSkeleton /> : fallback}>{children}</Suspense>
    </ErrorBoundary>
  );
}
