/**
 * Loads the KaTeX plugin chain only for markdown that actually contains math
 * (issue #269).
 *
 * The markdown source is already in hand when a message renders, so
 * `containsMath` decides synchronously whether to pay for KaTeX at all. When it
 * says yes, `mathRuntime` is fetched once, cached at module scope, and every
 * later math message picks it up synchronously — only the first one in a session
 * shows its `$…$` as literal text for the length of one chunk fetch.
 */
import { useEffect, useMemo, useState } from 'react';
import type { PluggableList } from 'unified';

import { containsMath } from './mathDetection';

type MathRuntime = typeof import('./mathRuntime');

let loadedRuntime: MathRuntime | null = null;
let pendingLoad: Promise<MathRuntime> | null = null;

/** The cached runtime, or `null` if nothing has needed math yet this session. */
export function getLoadedMathRuntime(): MathRuntime | null {
  return loadedRuntime;
}

/** Fetch `mathRuntime` at most once; concurrent callers share the promise. */
export function loadMathRuntime(): Promise<MathRuntime> {
  if (loadedRuntime) {
    return Promise.resolve(loadedRuntime);
  }
  if (!pendingLoad) {
    pendingLoad = import('./mathRuntime')
      .then((runtime) => {
        loadedRuntime = runtime;
        return runtime;
      })
      .catch((error) => {
        // A failed fetch must not poison the cache: the next math message
        // should be allowed to try again.
        pendingLoad = null;
        throw error;
      });
  }
  return pendingLoad;
}

/** Test seam — drops the module-level cache so a spec can observe a cold load. */
export function resetMathRuntimeForTests(): void {
  loadedRuntime = null;
  pendingLoad = null;
}

const NO_PLUGINS: PluggableList = [];

export type MathPlugins = {
  /** Append to the renderer's `remarkPlugins`. Empty until math is needed. */
  remarkMathPlugins: PluggableList;
  /** Append to the renderer's `rehypePlugins`. Empty until math is needed. */
  rehypeMathPlugins: PluggableList;
};

export function useMathPlugins(content: string): MathPlugins {
  const needsMath = useMemo(() => containsMath(content), [content]);
  // State only exists to re-render once the fetch lands; the module cache is
  // the source of truth so a second math message never flashes.
  const [, setLoadCount] = useState(0);
  const runtime = needsMath ? loadedRuntime : null;

  useEffect(() => {
    if (!needsMath || runtime) {
      return undefined;
    }
    let cancelled = false;
    loadMathRuntime()
      .then(() => {
        if (!cancelled) {
          setLoadCount((count) => count + 1);
        }
      })
      .catch((error) => {
        console.warn('Failed to load KaTeX math renderer:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [needsMath, runtime]);

  return useMemo(
    () => ({
      remarkMathPlugins: runtime ? [runtime.remarkMath] : NO_PLUGINS,
      rehypeMathPlugins: runtime ? [runtime.rehypeKatex] : NO_PLUGINS,
    }),
    [runtime],
  );
}
