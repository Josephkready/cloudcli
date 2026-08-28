/**
 * Boots an isolated cloudcli server for the benchmark and tears it down again.
 *
 * Deliberately close to `e2e/fixtures.ts`, and for the same reasons: a temp HOME
 * under `/var/tmp` (the workspace-path validator rejects `/tmp`), a throwaway
 * SQLite file, auth disabled, and the deterministic in-process agent provider
 * instead of a real CLI. The differences are what the benchmark needs on top:
 *
 *  - the HOME is *seeded* with a realistic transcript library before boot, so
 *    the first `/api/projects` pays a real cold-scan cost;
 *  - the port is chosen from a free-port probe rather than a worker index, since
 *    the benchmark runs standalone;
 *  - `waitForReady` waits for the session synchronizer's first pass to finish,
 *    not just for `/health`. Measuring an app whose index is still being built
 *    reports the indexer's cost inside whatever flow happened to run first.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

import { seedFixture, type ProfileName } from './seed.js';
import type { FixtureManifest } from './types.js';

export type BenchServer = {
  baseURL: string;
  port: number;
  home: string;
  fixture: FixtureManifest;
  /** Stops the server and deletes the fixture HOME. Safe to call twice. */
  stop: () => Promise<void>;
};

/** Asks the OS for a free port by binding one and immediately releasing it. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('bench: could not determine a free port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

async function getJson(url: string, timeoutMs = 120_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`GET ${url} failed (${response.status})`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url: string, body?: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed (${response.status}): ${await response.text()}`);
  }
}

export async function startBenchServer(options: {
  repoRoot: string;
  profile?: ProfileName;
  seed?: number;
  /** Prints seeding/boot progress. */
  onProgress?: (message: string) => void;
}): Promise<BenchServer> {
  const report = options.onProgress ?? (() => {});
  const home = mkdtempSync('/var/tmp/cloudcli-bench-');
  const port = await findFreePort();
  const baseURL = `http://127.0.0.1:${port}`;

  report(`seeding fixture in ${home} (profile: ${options.profile ?? 'standard'})`);
  const fixture = seedFixture({ home, profile: options.profile, seed: options.seed });
  report(
    `fixture: ${fixture.totals.projects} projects, ${fixture.totals.sessions} sessions, ` +
    `${fixture.totals.rows.toLocaleString()} transcript rows, ` +
    `${(fixture.totals.bytes / 1024 / 1024).toFixed(1)} MB`,
  );

  const child: ChildProcess = spawn(
    path.join(options.repoRoot, 'node_modules', '.bin', 'tsx'),
    ['--tsconfig', 'server/tsconfig.json', 'server/index.js'],
    {
      cwd: options.repoRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SERVER_PORT: String(port),
        HOST: '127.0.0.1',
        DATABASE_PATH: path.join(home, 'bench.db'),
        HOME: home,
        WORKSPACES_ROOT: home,
        VITE_AUTH_DISABLED: 'true',
        AGENT_MOCK_PROVIDER: 'true',
        JWT_SECRET: 'bench-secret',
        // Off by default already, but pinned explicitly: a background titler
        // firing real network calls against 60 seeded sessions would add load
        // the measurement cannot see or control.
        CLOUDCLI_AI_TITLES_ENABLED: 'false',
      },
    },
  );

  const log: string[] = [];
  let exitCode: number | null | undefined;
  child.stdout?.on('data', (chunk) => log.push(String(chunk)));
  child.stderr?.on('data', (chunk) => log.push(String(chunk)));
  child.on('exit', (code) => {
    exitCode = code;
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      if (child.pid) {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      /* already gone */
    }
    rmSync(home, { recursive: true, force: true });
  };

  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (exitCode !== undefined) {
        throw new Error(`bench: server exited (${exitCode}).\n${log.slice(-40).join('')}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`bench: server never became healthy.\n${log.slice(-40).join('')}`);
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        const response = await fetch(`${baseURL}/health`, { signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    report('server healthy — completing onboarding and warming the session index');
    await postJson(`${baseURL}/api/user/complete-onboarding`);

    // Force the cold scan to completion *before* any measurement. The first
    // `/api/projects` after boot runs the full synchronizer over the seeded
    // library; leaving that to whichever flow ran first would charge one flow
    // for indexing work that happens once in a real session, at install time.
    //
    // Retried because the scan is not strictly request-ordered: the sessions
    // watcher kicks off its own startup sync as the server begins accepting
    // connections, and a request that lands mid-scan can be answered from a
    // half-built index. A second ask a moment later sees the finished one.
    const started = Date.now();
    let discovered = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const projects = await getJson(`${baseURL}/api/projects`);
      discovered = Array.isArray(projects) ? projects.length : 0;
      if (discovered >= fixture.totals.projects) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    report(`cold session index built in ${Date.now() - started} ms (${discovered} projects visible)`);

    if (discovered < fixture.totals.projects) {
      throw new Error(
        `bench: only ${discovered} of ${fixture.totals.projects} seeded projects were indexed — ` +
        'the fixture is not being discovered, so any measurement would be meaningless.',
      );
    }

    return { baseURL, port, home, fixture, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
