import path from 'node:path';

import Database from 'better-sqlite3';

import { test, expect } from './fixtures';

/**
 * video-debugger Phase 1 round trip: real Chromium -> public/vd-recorder.js ->
 * POST /api/_vd/events -> server/modules/vdebug-capture -> flows.db.
 *
 * The privacy contract is what this pins, end to end:
 *   - the prompt typed into the composer is never stored (only kind + length);
 *   - clicks inside `[data-vd-mask]` regions (the conversation list, whose rows
 *     are session titles derived from prompts) carry no accessible name;
 *   - nav events carry no document.title (it holds the project name).
 *
 * The recorder skips automation (navigator.webdriver) by default so vdebug and
 * e2e runs never pollute the mined flows; this spec opts back in.
 */

const SECRET_PROMPT = 'zebra-secret-prompt-4417';

type Row = { type: string; target: string | null; data: string | null; path: string | null };

test('captures intent events without prompt text, masked names or titles', async ({ page, server }) => {
  await page.addInitScript(() => {
    (window as unknown as { VD_CAPTURE: object }).VD_CAPTURE = { captureAutomation: true, flushMs: 200 };
  });
  await page.goto('/');

  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();
  await composer.fill(SECRET_PROMPT);
  await composer.blur(); // fires `change` -> an `input` event (kind + length only)
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.chat-message.assistant').getByText('the mock provider.')).toBeVisible();

  // An unmasked sidebar control: its accessible name is safe and must be kept.
  await page.getByRole('button', { name: 'Refresh projects and sessions (Ctrl+R)' }).click();

  // A session row's accessible name IS the prompt; it lives under data-vd-mask.
  const row = page.getByRole('link', { name: new RegExp(SECRET_PROMPT) }).last();
  await expect(row).toBeVisible();
  await row.click();

  const dbPath = path.join(server.home, 'flows.db'); // beside DATABASE_PATH (auth.db)
  let rows: Row[] = [];
  await expect(async () => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      rows = db.prepare('SELECT type, target, data, path FROM events ORDER BY seq').all() as Row[];
    } finally {
      db.close();
    }
    expect(rows.some((r) => r.type === 'input')).toBe(true);
    expect(rows.filter((r) => r.type === 'click').length).toBeGreaterThanOrEqual(3);
  }).toPass({ timeout: 15_000 });

  const everything = JSON.stringify(rows);
  expect(everything).not.toContain(SECRET_PROMPT);
  expect(everything).not.toContain('zebra');
  expect(everything).not.toContain('CloudCLI UI'); // no document.title

  const input = rows.find((r) => r.type === 'input')!;
  expect(JSON.parse(input.data!)).toEqual({ kind: 'textarea', length: SECRET_PROMPT.length });

  const refresh = rows.find((r) => r.type === 'click' && r.target?.includes('"name":"Refresh projects'));
  expect(refresh, 'unmasked controls keep their locator name').toBeTruthy();

  // The whole composer is a prompt region, so even its Send button is nameless.
  const clicks = rows.filter((r) => r.type === 'click').map((r) => JSON.parse(r.target!));
  expect(clicks[0].tag).toBe('button');
  expect(clicks[0].name).toBeUndefined();

  const sessionClick = rows.filter((r) => r.type === 'click').at(-1)!;
  const target = JSON.parse(sessionClick.target!);
  expect(target.tag).toBe('a');
  expect(target.name).toBeUndefined(); // masked: no accessible name recorded
});
