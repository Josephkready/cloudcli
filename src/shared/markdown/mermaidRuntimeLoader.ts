/**
 * The one dynamic edge to mermaid, cached at module scope.
 *
 * Mirrors `loadMathRuntime` in `useMathPlugins.ts`: the first diagram in a
 * session pays for the chunk fetch and shows its source in the meantime, every
 * later diagram picks the runtime up from this cache and renders without a
 * second round trip.
 *
 * `typeof import(...)` is a type position, so it is erased and adds no edge to
 * the bundle — the `import()` inside `loadMermaidRuntime` is the only real one.
 */
type MermaidRuntime = typeof import('./mermaidRuntime');

let loadedRuntime: MermaidRuntime | null = null;
let pendingLoad: Promise<MermaidRuntime> | null = null;

/** The cached runtime, or `null` if no diagram has needed it yet this session. */
export function getLoadedMermaidRuntime(): MermaidRuntime | null {
  return loadedRuntime;
}

/** Fetch `mermaidRuntime` at most once; concurrent callers share the promise. */
export function loadMermaidRuntime(): Promise<MermaidRuntime> {
  if (loadedRuntime) {
    return Promise.resolve(loadedRuntime);
  }
  if (!pendingLoad) {
    pendingLoad = import('./mermaidRuntime')
      .then((runtime) => {
        loadedRuntime = runtime;
        return runtime;
      })
      .catch((error) => {
        // A failed fetch must not poison the cache: the next diagram should be
        // allowed to try again.
        pendingLoad = null;
        throw error;
      });
  }
  return pendingLoad;
}

/** Test seam — drops the module-level cache so a spec can observe a cold load. */
export function resetMermaidRuntimeForTests(): void {
  loadedRuntime = null;
  pendingLoad = null;
}
