import { test, expect } from './fixtures';

/**
 * P0 — the app boots login-free (VITE_AUTH_DISABLED), onboarding is already
 * seeded, and the chat WebSocket connects.
 */
test('boots login-free, renders the shell, and opens the chat websocket', async ({ page }) => {
  // The chat panel opens a WebSocket to `/ws` on load; capture it as proof the
  // realtime layer connected (not just that HTML rendered).
  const wsPromise = page.waitForEvent('websocket', {
    predicate: (ws) => ws.url().includes('/ws'),
    timeout: 20_000,
  });

  await page.goto('/');

  const ws = await wsPromise;
  expect(ws.url()).toContain('/ws');

  // The main app shell rendered (not the login/onboarding gate).
  await expect(page.getByRole('heading', { level: 1, name: 'CloudCLI' })).toBeVisible();

  // Auth is disabled: we must NOT land on the login/setup screen.
  await expect(page.getByRole('button', { name: /sign in|log in|create account/i })).toHaveCount(0);
});
