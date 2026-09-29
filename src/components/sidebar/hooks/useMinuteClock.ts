import { useSyncExternalStore } from 'react';

/**
 * A single shared "now" ticked once a minute, read via `useSyncExternalStore`.
 *
 * Sidebar rows (session/conversation rows) render a relative-age label
 * ("3m", "1hr") that needs to advance roughly once a minute. Previously each
 * row received `currentTime` as a prop threaded down from
 * `useSidebarController`'s own `setInterval`, which meant every row in the
 * tree re-rendered on every tick even though only the age label changed.
 *
 * `useSyncExternalStore` subscribers re-render independently of their parent
 * tree, so a component calling this hook re-renders on tick without forcing
 * its ancestors (or siblings that don't call this hook) to re-render too.
 * One `setInterval` is shared across every subscriber (ref-counted), not one
 * per row.
 */

let current = new Date();
let intervalId: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<() => void>();

const TICK_MS = 60_000;

function tick(): void {
  current = new Date();
  subscribers.forEach((notify) => notify());
}

function subscribe(onStoreChange: () => void): () => void {
  if (subscribers.size === 0 && typeof window !== 'undefined') {
    intervalId = setInterval(tick, TICK_MS);
  }

  subscribers.add(onStoreChange);

  return () => {
    subscribers.delete(onStoreChange);
    if (subscribers.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

function getSnapshot(): Date {
  return current;
}

export function useMinuteClock(): Date {
  // `getServerSnapshot` mirrors `getSnapshot` — the value carries no
  // client/server divergence, it's just "the last tick", so SSR (used by the
  // `renderToStaticMarkup` sidebar specs) reads the same singleton.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
