/**
 * The in-page measurement instrument.
 *
 * Installed with `page.addInitScript` so it is present before any app code runs,
 * which matters for two of the three things it collects: the `fetch` patch has
 * to be in place before the app captures a reference to it, and the `longtask`
 * observer has to be running before the bundle starts executing.
 *
 * Everything is timed inside the browser. A Playwright `click()` costs a CDP
 * round-trip of a few milliseconds — small, but the same order as some of the
 * steps here, and it varies with machine load. So the harness never times an
 * action from Node: it hands source strings to `__bench.measure`, which
 * dispatches the action and resolves the timer without leaving the page.
 *
 * ## What a step's `ms` actually covers
 *
 * `t0` is read immediately before the action is dispatched. `t1` is read in the
 * `requestAnimationFrame` callback that follows the first DOM state satisfying
 * the predicate — i.e. the frame that will paint the result. So `ms` is
 * "action → the frame that shows the user it worked", which is the thing the
 * user perceives, and it deliberately includes React's render and commit.
 */

/**
 * The instrument's public surface, as seen from Playwright's `evaluate`.
 * Mirrored here (rather than imported) because the implementation below is
 * serialized into the page and cannot share module scope with it.
 */
export type BenchSample = {
  ms: number;
  blockingMs: number;
  requests: Array<{ url: string; ms: number; bytes: number | null }>;
};

export type BenchInstrument = {
  measure(actionSource: string, predicateSource: string, timeoutMs: number): Promise<BenchSample>;
  /**
   * One action, then several checkpoints in order — each sample measured from
   * the previous checkpoint.
   *
   * This exists because splitting a flow into consecutive `measure` calls loses
   * time: between one call resolving and the next being dispatched there is a
   * CDP round-trip during which the app keeps working, and any checkpoint
   * reached inside that window reports as ~0 ms. A chat turn is exactly that
   * shape — send, user echo, first token, complete, settled — so its
   * checkpoints all have to be armed inside the page before the click lands.
   *
   * A checkpoint given as `{ predicate, endAt: 'idleStart' }` is timed to the
   * moment the last request actually settled rather than to the moment that
   * could be *confirmed*. "The app went quiet" is only observable by watching
   * nothing happen for a while, so its predicate necessarily becomes true a
   * fixed quiet-window late; charging that window to the app inflates every
   * settle step by the same constant and flattens the differences between them.
   */
  sequence(
    actionSource: string,
    checkpoints: Array<string | { predicate: string; endAt?: 'idleStart' }>,
    timeoutMs: number,
  ): Promise<BenchSample[]>;
  sinceNavigation(predicateSource: string, timeoutMs: number): Promise<BenchSample>;
  typeText(
    selector: string,
    text: string,
  ): Promise<{ totalMs: number; keystrokes: number[]; blockingMs: number }>;
  /** True once no request has been in flight for `quietMs`. Usable in a predicate. */
  idleFor(quietMs: number): boolean;
  reset(): void;
};

declare global {
  interface Window {
    __bench: BenchInstrument;
  }
}

/**
 * Installed into every page/frame before app scripts run.
 *
 * Written as one self-contained function with no imports and no closure over
 * module scope, because Playwright serializes it to source and evaluates it in
 * a fresh realm.
 */
export function installInstrument(): void {
  type Req = { url: string; start: number; end: number; bytes: number | null };

  const requests: Req[] = [];
  const longTasks: Array<{ start: number; end: number }> = [];
  /** Requests started but not yet settled — the basis of `idleFor`. */
  let inFlight = 0;
  /** When `inFlight` last fell to zero, so quiet periods can be measured. */
  let idleSince = performance.now();

  const noteRequestStarted = () => {
    inFlight += 1;
  };
  const noteRequestSettled = () => {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0) {
      idleSince = performance.now();
    }
  };

  // ── Network ───────────────────────────────────────────────────────────────
  // Only same-origin API traffic is interesting, and only the path is recorded:
  // a report keyed by full URL would fragment by port, and the port changes
  // every run because each server boots on a free one.
  const toPath = (input: string): string => {
    try {
      const url = new URL(input, window.location.origin);
      return url.origin === window.location.origin ? `${url.pathname}${url.search}` : url.href;
    } catch {
      return input;
    }
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = toPath(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const start = performance.now();
    noteRequestStarted();
    try {
      const response = await originalFetch(input as RequestInfo, init);
      // The body is what the app still has to parse, and reading `content-length`
      // is free; cloning to measure the decoded size is not, and would perturb
      // the very timings being collected.
      const declared = response.headers.get('content-length');
      // Clone before the app consumes it so recording the end time waits for the
      // bytes to land rather than for the headers — an endpoint that streams a
      // 3 MB transcript is fast to header and slow to finish, and it is the
      // finish the user waits on.
      const probe = response.clone();
      void probe.arrayBuffer().then((buffer) => {
        requests.push({
          url,
          start,
          end: performance.now(),
          bytes: declared !== null ? Number(declared) : buffer.byteLength,
        });
      }).catch(() => {
        requests.push({ url, start, end: performance.now(), bytes: null });
      }).finally(noteRequestSettled);
      return response;
    } catch (error) {
      requests.push({ url, start, end: performance.now(), bytes: null });
      noteRequestSettled();
      throw error;
    }
  };

  // ── Main-thread blocking ──────────────────────────────────────────────────
  // `longtask` entries are the browser's own account of when the main thread was
  // unavailable to respond. Pairing them with wall time is what separates "the
  // server was slow" from "we blocked the thread parsing and rendering it".
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ start: entry.startTime, end: entry.startTime + entry.duration });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // Firefox/WebKit do not implement longtask. Blocking then reports as 0,
    // which is why the harness pins itself to Chromium.
  }

  const blockingBetween = (start: number, end: number): number => {
    let total = 0;
    for (const task of longTasks) {
      const overlap = Math.min(task.end, end) - Math.max(task.start, start);
      if (overlap > 0) {
        total += overlap;
      }
    }
    return total;
  };

  const requestsBetween = (start: number, end: number) =>
    requests
      .filter((request) => request.start >= start - 1 && request.start <= end)
      .map((request) => ({ url: request.url, ms: request.end - request.start, bytes: request.bytes }));

  // ── Predicate waiting ─────────────────────────────────────────────────────
  /**
   * Resolves on the animation frame following the first moment `predicate`
   * holds.
   *
   * Driven by a `MutationObserver` *and* a per-frame poll, because neither alone
   * is sufficient: a predicate can turn true from a mutation deep in a subtree,
   * and it can also turn true with no mutation at all (an attribute the observer
   * is not watching, or a `disabled` flip React applies as a property).
   */
  const waitForPredicate = (predicate: () => boolean, timeoutMs: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const deadline = performance.now() + timeoutMs;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        // One frame later: the DOM now satisfies the predicate, and this is the
        // frame that paints it. Timing at the mutation instead would credit the
        // app for work the user cannot see yet.
        requestAnimationFrame(() => resolve(performance.now()));
      };

      const check = () => {
        if (settled) return;
        let holds = false;
        try {
          holds = Boolean(predicate());
        } catch {
          holds = false;
        }
        if (holds) {
          finish();
          return;
        }
        if (performance.now() > deadline) {
          settled = true;
          observer.disconnect();
          reject(new Error('bench: timed out waiting for predicate'));
          return;
        }
        requestAnimationFrame(check);
      };

      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      check();
    });

  // The strings compiled here come from `bench/flows.ts`, never from the page.
  // `no-new-func` is disabled for this whole block in eslint.config.js.
  const compile = (source: string): (() => unknown) =>
    new Function(`return (${source});`)() as () => unknown;

  const instrument: BenchInstrument = {
    async measure(actionSource, predicateSource, timeoutMs) {
      const [sample] = await instrument.sequence(actionSource, [predicateSource], timeoutMs);
      return sample;
    },

    async sequence(actionSource, checkpoints, timeoutMs) {
      const action = compile(actionSource);
      const normalized = checkpoints.map((checkpoint) =>
        typeof checkpoint === 'string' ? { predicate: checkpoint } : checkpoint,
      );
      const samples: Array<{ ms: number; blockingMs: number; requests: ReturnType<typeof requestsBetween> }> = [];

      let previous = performance.now();
      await action();
      for (const checkpoint of normalized) {
        const predicate = compile(checkpoint.predicate) as () => boolean;
        const confirmedAt = await waitForPredicate(predicate, timeoutMs);
        // `idleSince` is the instant the last in-flight request settled, which
        // is the real end of "the app stopped fetching". Bounded below by the
        // step's own start, because a step during which nothing was ever
        // fetched has an `idleSince` from before it began — and that step
        // genuinely took no time to go quiet.
        const end = checkpoint.endAt === 'idleStart'
          ? Math.min(confirmedAt, Math.max(previous, idleSince))
          : confirmedAt;

        samples.push({
          ms: end - previous,
          blockingMs: blockingBetween(previous, end),
          requests: requestsBetween(previous, end),
        });
        // The next step starts where this one ended as *observed*, not as
        // corrected: no time may be double-counted or silently dropped.
        previous = confirmedAt;
      }
      return samples;
    },

    async sinceNavigation(predicateSource, timeoutMs) {
      const predicate = compile(predicateSource) as () => boolean;
      // `performance.now()` is measured from this document's navigation start,
      // so the elapsed value *is* time-to-interactive without needing a t0.
      const end = await waitForPredicate(predicate, timeoutMs);
      return {
        ms: end,
        blockingMs: blockingBetween(0, end),
        requests: requestsBetween(0, end),
      };
    },

    async typeText(selector, text) {
      const field = document.querySelector(selector) as HTMLTextAreaElement | null;
      if (!field) {
        throw new Error(`bench: no element matches ${selector}`);
      }
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (!nativeSetter) {
        throw new Error('bench: cannot reach the native value setter');
      }

      field.focus();
      nativeSetter.call(field, '');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const keystrokes: number[] = [];
      const totalStart = performance.now();

      for (const character of text) {
        const next = field.value + character;
        const keyStart = performance.now();
        field.dispatchEvent(new KeyboardEvent('keydown', { key: character, bubbles: true }));
        nativeSetter.call(field, next);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new KeyboardEvent('keyup', { key: character, bubbles: true }));
        // React treats `input` as a discrete event and flushes the resulting
        // render synchronously, so this span is the app's real per-keystroke
        // cost: handler + state update + re-render + commit. It deliberately
        // excludes the wait for the next frame, which is dominated by the
        // display's cadence and would swamp the signal at ~16 ms a key.
        keystrokes.push(performance.now() - keyStart);
        // Yield a frame between keys so layout/paint actually happen, rather
        // than letting the browser coalesce 60 keystrokes into one render pass
        // and report a per-key cost no real typist would ever see.
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      const totalEnd = performance.now();
      return {
        totalMs: totalEnd - totalStart,
        keystrokes,
        blockingMs: blockingBetween(totalStart, totalEnd),
      };
    },

    idleFor(quietMs) {
      return inFlight === 0 && performance.now() - idleSince >= quietMs;
    },

    reset() {
      requests.length = 0;
      longTasks.length = 0;
    },
  };

  window.__bench = instrument;
}
