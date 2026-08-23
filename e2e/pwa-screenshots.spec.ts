import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { test, expect } from './fixtures';

/**
 * Regenerates the manifest's `screenshots` assets (issue #370).
 *
 * WHY IT LIVES IN THE E2E SUITE. These have to be pictures of the app actually
 * running, and this suite is the only place that already boots one — a real
 * server, a seeded project, and the deterministic mock provider, so the
 * conversation in the shot is reproducible rather than whatever happened to be
 * on screen.
 *
 * WHY IT IS SKIPPED BY DEFAULT. It writes binaries into `public/`, which is not
 * something a test run should do. It is opt-in:
 *
 *     CAPTURE_PWA_SCREENSHOTS=1 npx playwright test e2e/pwa-screenshots.spec.ts --project=chromium
 *
 * Then commit whatever changed under `public/icons/screenshots/`. Re-run it when
 * the chat surface changes enough that the install dialog would be showing a lie.
 *
 * The declared `sizes` in the manifest must match what this writes;
 * `src/pwa/pwaAssets.test.ts` fails the build if they drift.
 */

const SHOULD_CAPTURE = Boolean(process.env.CAPTURE_PWA_SCREENSHOTS);
const OUTPUT_DIR = path.join(process.cwd(), 'public', 'icons', 'screenshots');

// Must match the `sizes` declared in public/manifest.json.
const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };

test.describe('PWA install screenshots', () => {
  test.skip(!SHOULD_CAPTURE, 'set CAPTURE_PWA_SCREENSHOTS=1 to regenerate');

  test('captures the wide and narrow install screenshots', async ({ page }) => {
    mkdirSync(OUTPUT_DIR, { recursive: true });

    // One mock turn, so the shot shows a conversation rather than an empty
    // composer — the install dialog is meant to answer "what is this app".
    await page.setViewportSize(WIDE);
    await page.goto('/');

    const composer = page.locator('[data-slot="prompt-input-textarea"]');
    await expect(composer).toBeVisible();
    await composer.fill('What does this project do?');
    await page.getByRole('button', { name: 'Send' }).click();

    const assistant = page.locator('.chat-message.assistant');
    await expect(assistant.getByText('the mock provider.', { exact: false })).toBeVisible();
    // Wait for the terminal `complete`, not merely for the text: screenshotting
    // mid-stream leaves a "thinking…" pill and a Stop button in the shot, which
    // is a poor advertisement for a finished conversation.
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

    await page.screenshot({
      path: path.join(OUTPUT_DIR, 'wide.png'),
      clip: { x: 0, y: 0, ...WIDE },
    });

    // The same conversation at phone width. Deliberately a resize and NOT a
    // reload: the mock provider streams a turn without writing a transcript, so
    // a reload fetches an empty history and the shot would show the empty state
    // instead of a conversation.
    await page.setViewportSize(NARROW);
    await expect(page.locator('.chat-message.assistant').first()).toBeVisible();

    await page.screenshot({
      path: path.join(OUTPUT_DIR, 'narrow.png'),
      clip: { x: 0, y: 0, ...NARROW },
    });
  });
});
