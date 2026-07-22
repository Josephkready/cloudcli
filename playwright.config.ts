import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e config for cloudcli (issue #102).
 *
 * Strategy — production single-port build (recommended by the issue to avoid
 * Vite-proxy WebSocket flakiness): `global-setup.ts` builds the client bundle
 * once with `VITE_AUTH_DISABLED=true` baked in, and each worker boots its OWN
 * Express server (via `tsx`) that serves that `dist/` on a unique port. There is
 * deliberately no top-level `webServer`: the per-worker server lifecycle +
 * temp-DB/temp-HOME seeding all live in the worker-scoped `server` fixture
 * (see e2e/fixtures.ts), which also supplies each worker's `baseURL`.
 *
 * The chat provider is the deterministic in-process mock
 * (`AGENT_MOCK_PROVIDER=true` re-points the claude/codex runtimes at
 * server/routes/mock-agent-provider.js), so a full browser chat turn runs with
 * no real CLI/SDK, network, or auth.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // Each spec gets a generous but bounded budget; the app boot + mock chat turn
  // is fast, so a spec that hangs is a real failure, not a slow machine.
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // Isolation is per-worker (own server + temp DB + temp HOME), so workers may
  // run in parallel safely. Specs within a file run serially.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    // baseURL is injected per-worker by the `server` fixture.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
