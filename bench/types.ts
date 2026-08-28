/**
 * Shared types for the end-to-end performance benchmark.
 *
 * The unit of measurement is a **step**: one user action (a click, a keystroke,
 * a navigation) paired with the DOM condition that tells the user "it happened".
 * Everything else — flows, runs, reports — is an aggregation of steps.
 *
 * Steps are timed *inside the browser*: `performance.now()` is read immediately
 * before the action is dispatched and again on the first animation frame where
 * the condition holds. Nothing in a sample includes Playwright's CDP round-trip,
 * so a number here is app time, not harness time.
 */

/** One timed step, as returned by the in-page instrument. */
export type StepSample = {
  /** Stable id, e.g. `session_switch.click_to_first_paint`. */
  step: string;
  /** Wall-clock ms from action dispatch to the condition holding. */
  ms: number;
  /**
   * Main-thread blocking during the step, in ms, from `PerformanceObserver`'s
   * `longtask` entries clipped to the step window. High blocking with low API
   * time means the cost is rendering; the reverse means it is the server.
   */
  blockingMs: number;
  /** Every `fetch`/XHR that started during the step, with its own duration. */
  requests: RequestSample[];
};

/** One network request observed during a step. */
export type RequestSample = {
  /** Path only (query string preserved, origin stripped) — keeps reports stable. */
  url: string;
  ms: number;
  /** Bytes of response body, when the browser reported a content length. */
  bytes: number | null;
};

/** One complete pass through one flow. */
export type FlowIteration = {
  flow: string;
  steps: StepSample[];
  /** Sum of the flow's step durations — the headline end-to-end number. */
  totalMs: number;
};

/** Percentile summary over N iterations of one step (or one whole flow). */
export type Summary = {
  n: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
};

/** Aggregated results for one flow across all iterations. */
export type FlowResult = {
  flow: string;
  /** Human-readable description of what the flow does. */
  description: string;
  /** End-to-end totals across iterations. */
  total: Summary;
  /** Per-step breakdown, in the order the steps ran. */
  steps: Array<{
    step: string;
    description: string;
    duration: Summary;
    blocking: Summary;
    /** Endpoints touched during this step, aggregated by path. */
    api: Array<{ url: string; calls: number; medianMs: number; totalMs: number }>;
  }>;
};

/** A whole benchmark run: the environment, the fixture, and every flow result. */
export type BenchReport = {
  /** ISO timestamp of the run. */
  startedAt: string;
  /** Short label for the run, e.g. `baseline` or `optimized`. */
  label: string;
  /** Git commit the run measured, when the tree is clean enough to name one. */
  commit: string | null;
  environment: {
    node: string;
    platform: string;
    cpus: number;
    /** Playwright browser + version actually driven. */
    browser: string;
    /**
     * 1-minute load average when the run started and when it finished.
     *
     * Recorded because these flows are sensitive to anything else using the
     * machine, and the failure is silent: a run that overlaps a test suite or a
     * build reports the contention as a regression in whichever flows happened
     * to run during it. Two reports whose load differs materially are not
     * comparable, and without this there is nothing to notice that from.
     */
    loadAverage: { atStart: number; atEnd: number };
  };
  fixture: FixtureManifest;
  config: {
    iterations: number;
    warmup: number;
  };
  flows: FlowResult[];
};

/** What the seeder actually wrote to disk, so a report is self-describing. */
export type FixtureManifest = {
  home: string;
  seed: number;
  profile: string;
  projects: Array<{
    name: string;
    path: string;
    isGitRepo: boolean;
    sessions: Array<{
      id: string;
      title: string;
      /** Rows written to the JSONL (not the same as rendered messages). */
      rows: number;
      bytes: number;
    }>;
  }>;
  totals: {
    projects: number;
    sessions: number;
    rows: number;
    bytes: number;
  };
  /** Session ids the flows navigate to, chosen by the seeder. */
  targets: {
    /** A deliberately large transcript — the session-switch worst case. */
    largeSessionId: string;
    /** A typical-length transcript — the session-switch common case. */
    typicalSessionId: string;
    /** The project the flows do their work in. */
    primaryProjectPath: string;
  };
};
