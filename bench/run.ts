/**
 * Benchmark entry point — `npm run bench`.
 *
 * One invocation: build the client (once), seed a fixture library, boot a server
 * against it, drive every flow N times in a real Chromium, and print a table.
 * `--out` writes the full JSON report, `--compare` prints it against a previous
 * one.
 *
 * ```
 * npm run bench -- --label baseline --out bench/results/baseline.json
 * npm run bench -- --label optimized --compare bench/results/baseline.json
 * ```
 *
 * Chromium is pinned deliberately. `longtask` — the entry type that separates
 * "the server was slow" from "we blocked the main thread" — is Chromium-only, so
 * running this on WebKit would silently report zero blocking everywhere.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type BrowserContext } from '@playwright/test';

import { buildFlows, type Flow, type FlowContext } from './flows.js';
import { installInstrument } from './instrument.js';
import { aggregateFlow, renderComparison, renderMarkdown, renderReport } from './report.js';
import { round } from './stats.js';
import { startBenchServer } from './server.js';
import type { ProfileName } from './seed.js';
import type { BenchReport, FlowIteration } from './types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Options = {
  profile: ProfileName;
  seed: number;
  iterations: number;
  warmup: number;
  label: string;
  out: string | null;
  markdown: string | null;
  compare: string | null;
  only: string[] | null;
  skipBuild: boolean;
  headed: boolean;
  /** `[before, after]` JSON reports to diff without measuring anything. */
  diff: [string, string] | null;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    profile: 'standard',
    seed: 20260815,
    iterations: 7,
    warmup: 2,
    label: 'run',
    out: null,
    markdown: null,
    compare: null,
    only: null,
    skipBuild: false,
    headed: false,
    diff: null,
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) {
        throw new Error(`bench: ${argument} needs a value`);
      }
      return value;
    };

    switch (argument) {
      case '--profile': options.profile = next() as ProfileName; break;
      case '--seed': options.seed = Number(next()); break;
      case '--iterations': options.iterations = Number(next()); break;
      case '--warmup': options.warmup = Number(next()); break;
      case '--label': options.label = next(); break;
      case '--out': options.out = path.resolve(REPO_ROOT, next()); break;
      case '--markdown': options.markdown = path.resolve(REPO_ROOT, next()); break;
      case '--compare': options.compare = path.resolve(REPO_ROOT, next()); break;
      case '--only': options.only = next().split(',').map((value) => value.trim()).filter(Boolean); break;
      case '--diff': options.diff = [next(), next()]; break;
      case '--skip-build': options.skipBuild = true; break;
      case '--headed': options.headed = true; break;
      case '--help':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`bench: unknown argument ${argument}`);
    }
  }

  return options;
}

const HELP = `
npm run bench -- [options]

  --profile <small|standard|large>  Fixture size (default: standard)
  --seed <n>                        Fixture PRNG seed (default: 20260815)
  --iterations <n>                  Measured iterations per flow (default: 7)
  --warmup <n>                      Discarded iterations per flow (default: 2)
  --label <name>                    Label for this run (default: run)
  --only <a,b>                      Run only these flows
  --out <file>                      Write the JSON report here
  --markdown <file>                 Write a Markdown summary here
  --compare <file>                  Print this run against a previous JSON report
  --diff <before> <after>           Diff two saved JSON reports and exit (no measuring)
  --skip-build                      Reuse the existing dist/ (must be auth-disabled)
  --headed                          Show the browser
`.trim();

/** Builds the client bundle with auth disabled, exactly as the e2e setup does. */
function buildClient(skip: boolean): void {
  const distIndex = path.join(REPO_ROOT, 'dist', 'index.html');
  if (skip && existsSync(distIndex)) {
    console.log('[bench] --skip-build: reusing the existing dist/');
    return;
  }
  console.log('[bench] building client bundle (VITE_AUTH_DISABLED=true)...');
  execFileSync('npm', ['run', 'build:client'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_AUTH_DISABLED: 'true' },
  });
}

function currentCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Runs one flow `iterations` times, discarding `warmup` runs first.
 *
 * Warmup is not a formality here. The first pass through any flow pays for the
 * V8 tier-up of the app's own code, the HTTP connection, and — for anything that
 * reads a transcript — the OS page cache for that file. Reporting those in the
 * median would make every flow look worse than it is and would move with
 * unrelated machine state.
 */
async function runFlow(
  flow: Flow,
  environment: {
    makeContext: (cold: boolean) => Promise<{ context: BrowserContext; dispose: () => Promise<void> }>;
    baseURL: string;
    fixture: BenchReport['fixture'];
    iterations: number;
    warmup: number;
  },
): Promise<FlowIteration[]> {
  const results: FlowIteration[] = [];
  const total = environment.warmup + environment.iterations;

  for (let iteration = 0; iteration < total; iteration++) {
    const isWarmup = iteration < environment.warmup;
    const { context, dispose } = await environment.makeContext(Boolean(flow.cold));
    const page = await context.newPage();
    try {
      const flowContext: FlowContext = { page, baseURL: environment.baseURL, fixture: environment.fixture };
      await flow.prepare(flowContext);
      const steps = await flow.measure(flowContext);
      if (!isWarmup) {
        results.push({
          flow: flow.id,
          steps,
          totalMs: steps.reduce((sum, step) => sum + step.ms, 0),
        });
      }
    } finally {
      await page.close();
      await dispose();
    }
    process.stdout.write(isWarmup ? '.' : '#');
  }
  process.stdout.write('\n');

  return results;
}

/**
 * Creates a browser context with the measurement instrument installed.
 *
 * The `__name` shim is not optional. `tsx` runs this harness through esbuild
 * with `keepNames` on, which rewrites every named function/arrow as
 * `__name(fn, 'fn')` and declares `__name` once at module scope. Playwright
 * serializes `installInstrument` with `Function.prototype.toString`, so those
 * calls travel into the page while the declaration does not — and the init
 * script dies with `__name is not defined` before it can export `window.__bench`.
 * Every flow then fails with the far less obvious "Cannot read properties of
 * undefined (reading 'sequence')".
 *
 * The identity shim restores it. Injected as its own init script so it is
 * evaluated first, and asserted immediately afterwards so a future esbuild
 * helper that is *not* shimmed fails here, naming itself, rather than surfacing
 * as a missing instrument.
 */
async function newInstrumentedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript({
    content: 'globalThis.__name = globalThis.__name || ((value) => value);',
  });
  await context.addInitScript(installInstrument);
  await context.addInitScript({
    // The sidebar hides CLI-origin conversations by default (#216), and every
    // seeded conversation is CLI-origin by construction: the synchronizer finds
    // them on disk, which is exactly what makes `session_id === provider_session_id`.
    // Left at the default, the fixture's whole library is invisible and the
    // benchmark measures an empty app. Flipping the same preference the
    // "Show" affordance writes is the honest fix — the rows are real, and this
    // is the setting a user with a CLI-heavy library runs with.
    content: `try { localStorage.setItem('claude-settings', JSON.stringify({ hideCliOriginChats: false })); } catch {}`,
  });

  // Surface page-side failures instead of letting them present as a hung
  // predicate 30 seconds later.
  context.on('page', (page) => {
    page.on('pageerror', (error) => {
      console.error(`[bench] page error: ${error.message}`);
    });
  });

  return context;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Pure reporting: re-render a comparison from two runs already on disk. Useful
  // on a shared machine, where the honest way to compare two commits is to
  // measure both back to back and diff the saved reports afterwards, rather than
  // holding one of them up against a report from another hour.
  if (options.diff) {
    const [beforePath, afterPath] = options.diff;
    const before = JSON.parse(readFileSync(path.resolve(REPO_ROOT, beforePath), 'utf8')) as BenchReport;
    const after = JSON.parse(readFileSync(path.resolve(REPO_ROOT, afterPath), 'utf8')) as BenchReport;
    console.log(renderComparison(before, after));
    if (options.markdown) {
      mkdirSync(path.dirname(options.markdown), { recursive: true });
      writeFileSync(options.markdown, `${renderMarkdown(after, before)}\n`);
      console.log(`[bench] Markdown summary written to ${path.relative(REPO_ROOT, options.markdown)}`);
    }
    return;
  }

  buildClient(options.skipBuild);

  // Sampled after the build (which is itself load) but before any measurement.
  const loadAtStart = os.loadavg()[0];

  const server = await startBenchServer({
    repoRoot: REPO_ROOT,
    profile: options.profile,
    seed: options.seed,
    onProgress: (message) => console.log(`[bench] ${message}`),
  });

  const browser: Browser = await chromium.launch({ headless: !options.headed });
  const allFlows = buildFlows(server.fixture);
  const flows = options.only
    ? allFlows.filter((flow) => options.only!.includes(flow.id))
    : allFlows;

  if (flows.length === 0) {
    throw new Error(`bench: --only matched no flows (available: ${allFlows.map((flow) => flow.id).join(', ')})`);
  }

  // Warm flows share one browser context for the whole flow, so the app is not
  // relaunched between iterations — a user clicking through conversations does
  // not get a fresh browser each time.
  let sharedContext: BrowserContext | undefined;
  const makeContext = async (cold: boolean) => {
    if (cold) {
      const context = await newInstrumentedContext(browser);
      return { context, dispose: async () => { await context.close(); } };
    }
    if (sharedContext === undefined) {
      sharedContext = await newInstrumentedContext(browser);
    }
    return { context: sharedContext, dispose: async () => {} };
  };

  const results: BenchReport['flows'] = [];
  try {
    for (const flow of flows) {
      process.stdout.write(`[bench] ${flow.id} `);
      const iterations = await runFlow(flow, {
        makeContext,
        baseURL: server.baseURL,
        fixture: server.fixture,
        iterations: options.iterations,
        warmup: options.warmup,
      });
      results.push(aggregateFlow(flow, iterations));
    }
  } finally {
    if (sharedContext) {
      await sharedContext.close();
    }
    await browser.close();
    await server.stop();
  }

  const report: BenchReport = {
    startedAt: new Date().toISOString(),
    label: options.label,
    commit: currentCommit(),
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      cpus: os.cpus().length,
      browser: `chromium ${browser.version()}`,
      loadAverage: { atStart: round(loadAtStart, 2), atEnd: round(os.loadavg()[0], 2) },
    },
    fixture: server.fixture,
    config: { iterations: options.iterations, warmup: options.warmup },
    flows: results,
  };

  console.log(renderReport(report));

  let baseline: BenchReport | null = null;
  if (options.compare) {
    baseline = JSON.parse(readFileSync(options.compare, 'utf8')) as BenchReport;
    console.log(renderComparison(baseline, report));
  }

  if (options.out) {
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[bench] JSON report written to ${path.relative(REPO_ROOT, options.out)}`);
  }

  if (options.markdown) {
    mkdirSync(path.dirname(options.markdown), { recursive: true });
    writeFileSync(options.markdown, `${renderMarkdown(report, baseline)}\n`);
    console.log(`[bench] Markdown summary written to ${path.relative(REPO_ROOT, options.markdown)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
