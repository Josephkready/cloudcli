/**
 * Chunk-loading helpers for the app's lazy surfaces (issue #267).
 *
 * Kept free of React so the retry policy — the only part with real branching —
 * can be covered by the fast `node:test` runner (see CONTRIBUTING's `.pure.ts`
 * convention).
 */

export type LoadWithRetryOptions = {
  /** Extra attempts after the first one. */
  retries?: number;
  /** Delay before each retry, in milliseconds. */
  delayMs?: number;
  /** Injectable sleep so tests do not have to wait in real time. */
  wait?: (ms: number) => Promise<void>;
};

const defaultWait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Run a dynamic `import()` with a bounded retry.
 *
 * `React.lazy` invokes its factory exactly once and memoises the outcome —
 * including a rejection. Without this, a single failed chunk request (flaky
 * mobile network, or a deploy that replaced the hashed asset while the tab was
 * open) would permanently break that surface for the life of the document, with
 * no way back except a manual reload. Retrying *inside* the factory keeps the
 * common, transient failure invisible; a genuinely missing chunk still rejects
 * and is caught by the surrounding error boundary rather than white-screening
 * the app.
 */
export async function loadWithRetry<T>(
  load: () => Promise<T>,
  { retries = 1, delayMs = 300, wait = defaultWait }: LoadWithRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(0, retries) + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await wait(delayMs);
      }
    }
  }

  throw lastError;
}
