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
/**
 * Anchored to the file name, deliberately.
 *
 * These patterns are matched against each spec's **absolute** path, so an
 * unanchored `/mobile-keyboard.*\.spec\.ts/` also matches any spec that merely
 * lives under a directory containing that phrase — and `/start-work` names its
 * worktree after the task, so developing this very feature produced
 * `/tmp/cloudcli-fix-mobile-keyboard-.../e2e/chat.spec.ts` and silently emptied
 * the desktop project. A config that quietly runs nothing is far worse than one
 * that fails, so the leading separator and trailing `$` are load-bearing.
 *
 * `bug-report-capture` belongs here rather than with the desktop specs even
 * though it files a report rather than laying one out: what it asserts is that
 * the reporter's viewport snapshot survives the blur that opening it causes,
 * which is only a question where a soft keyboard exists.
 */
const KEYBOARD_SPECS =
  /[\\/](mobile-keyboard(-publisher)?|bug-report-capture)\.spec\.ts$/;

/**
 * Specs that must run on every engine, desktop and mobile alike.
 *
 * `composer-focus` (#367) is one bug with two faces: on desktop losing focus
 * costs a click, on a phone it closes the on-screen keyboard after every single
 * message. Pinning it on only one engine would leave half the report uncovered,
 * and WebKit is the only engine here that can speak to an iPhone report.
 *
 * Same anchoring rules as above — the leading separator and trailing `$` are
 * load-bearing, because these are matched against absolute paths and the
 * worktree directory is named after the task being developed.
 */
const CROSS_ENGINE_SPECS = /[\\/]composer-focus\.spec\.ts$/;

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
      // The mobile-keyboard specs have their own projects below; excluding them
      // here keeps them from running a third time under desktop metrics, where a
      // soft keyboard is meaningless.
      testIgnore: KEYBOARD_SPECS,
      use: { ...devices['Desktop Chrome'] },
    },
    // The soft-keyboard specs run on BOTH engines, and the WebKit half is the
    // point: WebKit is the engine Safari ships, so it is the only one here that
    // can speak to an iPhone report at all. Chromium runs alongside it to catch
    // the reverse — a keyboard fix that quietly breaks Android.
    //
    // Scoped by `testMatch` rather than added globally: pointing the whole suite
    // at WebKit would be a much larger and unrelated change, and a slower gate.
    {
      name: 'mobile-safari',
      testMatch: [KEYBOARD_SPECS, CROSS_ENGINE_SPECS],
      use: { ...devices['iPhone 14 Pro'] },
    },
    {
      name: 'mobile-chrome',
      testMatch: [KEYBOARD_SPECS, CROSS_ENGINE_SPECS],
      use: { ...devices['Pixel 7'] },
    },
  ],
});
