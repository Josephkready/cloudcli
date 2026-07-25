import { useEffect } from 'react';

import type { SurfaceLoader } from './surfaceLoaders';
import { shouldWarmSurfaces, type ConnectionLike } from './warmSurfaces.pure';

type NavigatorWithConnection = Navigator & { connection?: ConnectionLike };

const IDLE_TIMEOUT_MS = 10_000;
const FALLBACK_DELAY_MS = 2_000;

/**
 * Pull the heavy demand-loaded surfaces into the module registry once the page
 * is done loading (issue #267).
 *
 * A `<link rel=prefetch>` was the obvious answer here and it is not enough.
 * Prefetch warms the *HTTP cache*, so the click still pays for parsing the
 * chunk and for the extra Suspense render that comes with resolving a lazy
 * component — measured at 4x CPU / 8 Mbps, the first chat -> shell switch went
 * from 955 ms (everything eagerly bundled) to 1687 ms with prefetch alone, but
 * to 844 ms when the module had actually been evaluated. Prefetch in the
 * initial HTML also has a real cost of its own: the preload scanner starts the
 * fetch immediately and it competes with first paint (FCP 1028 ms -> 1208 ms).
 *
 * So: no markup, one `import()` per surface, scheduled after the load event and
 * inside `requestIdleCallback` — after first paint, one idle slice each, and
 * skipped entirely on a metered or 2G connection.
 */
export function useWarmLazySurfaces(loaders: SurfaceLoader[]): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    const connection = (navigator as NavigatorWithConnection).connection;
    if (!shouldWarmSurfaces(connection)) {
      return undefined;
    }

    let cancelled = false;
    const idleHandles: number[] = [];
    const timeoutHandles: number[] = [];

    const schedule = (task: () => void) => {
      if (typeof window.requestIdleCallback === 'function') {
        idleHandles.push(window.requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS }));
        return;
      }
      // Safari has no requestIdleCallback; a plain delay is enough to stay out
      // of the way of first paint, which is the only thing that matters here.
      timeoutHandles.push(window.setTimeout(task, FALLBACK_DELAY_MS));
    };

    const warm = () => {
      for (const load of loaders) {
        // One idle callback per surface so a slow chunk cannot monopolise a
        // single slice and turn the warm-up into a long task of its own.
        schedule(() => {
          if (cancelled) return;
          // A failed warm-up is a non-event: the surface will simply load on
          // demand, through its own error boundary, when the user clicks.
          void load().catch(() => {});
        });
      }
    };

    if (document.readyState === 'complete') {
      warm();
    } else {
      window.addEventListener('load', warm, { once: true });
    }

    return () => {
      cancelled = true;
      window.removeEventListener('load', warm);
      if (typeof window.cancelIdleCallback === 'function') {
        idleHandles.forEach((handle) => window.cancelIdleCallback(handle));
      }
      timeoutHandles.forEach((handle) => window.clearTimeout(handle));
    };
  }, [loaders]);
}
