import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

import { test as base, expect } from '@playwright/test';

/**
 * Per-worker server + isolated state.
 *
 * Each Playwright worker boots its OWN cloudcli Express server (via `tsx`, no
 * server build needed) with:
 *   - a unique SERVER_PORT (single-port prod-style: the server serves the
 *     pre-built dist/ SPA — no Vite proxy),
 *   - a throwaway DATABASE_PATH,
 *   - a temp HOME under /var/tmp, so `GET /api/projects` scans an empty
 *     `~/.claude` instead of the real (slow) one (issue #188),
 *   - VITE_AUTH_DISABLED=true (login-free boot, seeds the default user),
 *   - AGENT_MOCK_PROVIDER=true (chat runtimes re-pointed at the deterministic
 *     in-process mock).
 *
 * One project is seeded straight into the database before the server starts
 * (there is no create-project endpoint), then onboarding is completed over REST
 * (auth is disabled, so no token is needed). The worker's tests get a `baseURL`
 * plus the seeded project path.
 */

export type E2EServer = {
  baseURL: string;
  port: number;
  home: string;
  projectPath: string;
  projectName: string;
};

const REPO_ROOT = process.cwd();
const BASE_PORT = Number(process.env.E2E_BASE_PORT || 4700);

async function waitForHealth(
  baseURL: string,
  options: { timeoutMs?: number; isDead?: () => string | null } = {},
): Promise<void> {
  const { timeoutMs = 45_000, isDead } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    // Fail fast (with the captured server output) if the server process already
    // exited, instead of polling a dead port for the full timeout.
    const deadMessage = isDead?.();
    if (deadMessage) {
      throw new Error(`Server at ${baseURL} exited before becoming healthy. ${deadMessage}`);
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      const res = await fetch(`${baseURL}/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server at ${baseURL} did not become healthy in ${timeoutMs}ms: ${String(lastError)}`);
}

async function postJson(baseURL: string, endpoint: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${baseURL}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(`POST ${endpoint} failed (${res.status}): ${text}`);
  }
  return parsed;
}

export const test = base.extend<
  { seededProjectPath: string },
  { server: E2EServer }
>({
  server: [
    async ({}, use, workerInfo) => {
      const port = BASE_PORT + workerInfo.workerIndex;
      const baseURL = `http://127.0.0.1:${port}`;
      const home = mkdtempSync('/var/tmp/cloudcli-e2e-');
      const dbPath = path.join(home, 'auth.db');
      const projectName = 'e2e-project';
      const projectPath = path.join(home, projectName);
      mkdirSync(projectPath);
      execFileSync(
        path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
        ['--tsconfig', 'server/tsconfig.json', 'server/modules/database/seed-project.ts', projectPath, projectName],
        { cwd: REPO_ROOT, env: { ...process.env, DATABASE_PATH: dbPath, HOME: home }, stdio: 'pipe' },
      );

      const child: ChildProcess = spawn(
        path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
        ['--tsconfig', 'server/tsconfig.json', 'server/index.js'],
        {
          cwd: REPO_ROOT,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            SERVER_PORT: String(port),
            HOST: '127.0.0.1',
            DATABASE_PATH: dbPath,
            HOME: home,
            VITE_AUTH_DISABLED: 'true',
            AGENT_MOCK_PROVIDER: 'true',
            JWT_SECRET: 'e2e-secret',
          },
        },
      );

      // Surface server crashes in the test log without spamming normal output.
      const serverLog: string[] = [];
      let serverExitCode: number | null | undefined;
      child.stdout?.on('data', (d) => serverLog.push(String(d)));
      child.stderr?.on('data', (d) => serverLog.push(String(d)));
      child.on('exit', (code) => {
        serverExitCode = code;
        if (code && code !== 0) {
          console.error(`[e2e] worker ${workerInfo.workerIndex} server exited (${code}):\n${serverLog.slice(-30).join('')}`);
        }
      });

      try {
        await waitForHealth(baseURL, {
          isDead: () =>
            serverExitCode !== undefined
              ? `Exit code ${serverExitCode}. Last server output:\n${serverLog.slice(-30).join('')}`
              : null,
        });
        // Seed: complete onboarding for the default user (the project row is already in the DB).
        await postJson(baseURL, '/api/user/complete-onboarding');

        await use({ baseURL, port, home, projectPath, projectName });
      } finally {
        // Kill the whole detached process group defensively, then clear temp state.
        try {
          if (child.pid) {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          /* already gone */
        }
        rmSync(home, { recursive: true, force: true });
      }
    },
    { scope: 'worker', auto: true },
  ],

  // Route every test's navigation/API to this worker's server.
  baseURL: async ({ server }, use) => {
    await use(server.baseURL);
  },

  // Convenience: the seeded project's absolute path.
  seededProjectPath: async ({ server }, use) => {
    await use(server.projectPath);
  },
});

export { expect };
