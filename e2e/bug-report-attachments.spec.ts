import path from 'node:path';

import { test, expect } from './fixtures';

/**
 * Bug-report screenshots (dante-config skills/bug-report-button/SKILL.md §9),
 * end-to-end at the DOM/wiring tier: choosing a real file produces a
 * thumbnail preview, and Send carries the COMPRESSED bytes as a real
 * multipart part alongside the typed text — never the original file, and
 * never blocking a report that has no image.
 *
 * `/api/bug-report` is intercepted rather than left to hit the real server:
 * this environment has no `issue-queue` binary configured (see
 * `e2e/fixtures.ts`), and what matters here is what the BROWSER sent, which
 * server-side re-validation (covered directly in
 * `server/routes/bug-report.test.ts`) is a separate concern from. The service
 * worker (`public/sw.js`) explicitly never intercepts `/api/` requests, so
 * `page.route` sees this POST exactly as it left the page.
 */

const ICON_PATH = path.join(process.cwd(), 'public', 'logo-128.png');
const QUEUED_JOB_ID = '11111111-2222-3333-4444-555555555555';

function queuedResponse() {
  return JSON.stringify({ success: true, data: { status: 'queued', id: QUEUED_JOB_ID } });
}

test('choosing a screenshot compresses it and sends it as a multipart part', async ({ page }) => {
  let posted: { body: Buffer | null; contentType: string } | null = null;
  await page.route('**/api/bug-report', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    posted = {
      body: route.request().postDataBuffer(),
      contentType: route.request().headers()['content-type'] ?? '',
    };
    await route.fulfill({ status: 202, contentType: 'application/json', body: queuedResponse() });
  });

  await page.goto('/');
  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();

  await page.getByRole('button', { name: 'Report a bug' }).click();
  const description = page.locator('#bug-report-description');
  await expect(description).toBeVisible();

  await page.setInputFiles('[data-testid="bug-report-file-input"]', ICON_PATH);
  await expect(page.getByTestId('bug-report-attachment-thumbnail')).toBeVisible();
  await expect(page.getByText('Screenshots may show more of your screen', { exact: false })).toBeVisible();

  await description.fill('See the attached screenshot for details');
  await page.getByRole('button', { name: 'File issue' }).click();

  await expect.poll(() => posted?.body != null).toBe(true);
  const { body, contentType } = posted!;
  expect(contentType).toContain('multipart/form-data');

  const raw = body!.toString('latin1');
  expect(raw).toContain('name="attachments"');
  expect(raw).toContain('filename="');
  expect(raw).toContain('See the attached screenshot for details');
  // Compressed client-side before it ever reached the network — the source is
  // a PNG (`\x89PNG` magic bytes); the wire body carries the re-encoded
  // WebP/JPEG instead, and is a real, much smaller re-encode of the same
  // image, not the original file passed through untouched.
  expect(raw).not.toContain('\x89PNG\r\n\x1a\n');
  expect(raw).toMatch(/Content-Type: image\/(webp|jpeg)/);
});

test('the remove control drops the staged image before send', async ({ page }) => {
  let posted: Buffer | null = null;
  await page.route('**/api/bug-report', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    posted = route.request().postDataBuffer();
    await route.fulfill({ status: 202, contentType: 'application/json', body: queuedResponse() });
  });

  await page.goto('/');
  await expect(page.locator('[data-slot="prompt-input-textarea"]')).toBeVisible();

  await page.getByRole('button', { name: 'Report a bug' }).click();
  const description = page.locator('#bug-report-description');
  await expect(description).toBeVisible();

  await page.setInputFiles('[data-testid="bug-report-file-input"]', ICON_PATH);
  await expect(page.getByTestId('bug-report-attachment-thumbnail')).toBeVisible();

  await page.getByTestId('bug-report-attachment-remove').click();
  await expect(page.getByTestId('bug-report-attachment-thumbnail')).toHaveCount(0);

  await description.fill('no image after all, please still send this');
  await page.getByRole('button', { name: 'File issue' }).click();

  await expect.poll(() => posted != null).toBe(true);
  expect(posted!.toString('utf8')).not.toContain('name="attachments"');
});

test('a report with no screenshot keeps posting a plain JSON body', async ({ page }) => {
  let contentType = '';
  await page.route('**/api/bug-report', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    contentType = route.request().headers()['content-type'] ?? '';
    await route.fulfill({ status: 202, contentType: 'application/json', body: queuedResponse() });
  });

  await page.goto('/');
  await expect(page.locator('[data-slot="prompt-input-textarea"]')).toBeVisible();

  await page.getByRole('button', { name: 'Report a bug' }).click();
  const description = page.locator('#bug-report-description');
  await expect(description).toBeVisible();
  await description.fill('no screenshot needed for this one');
  await page.getByRole('button', { name: 'File issue' }).click();

  await expect.poll(() => contentType !== '').toBe(true);
  expect(contentType).toContain('application/json');
});
