import { test, expect } from './fixtures';

/**
 * P0 — the core chat loop against the deterministic mock provider:
 * send a message → the streamed assistant reply renders → the run reaches its
 * terminal `complete` → the session is created, appears in the sidebar, and is
 * addressable at /session/:id.
 */
test('runs a full mock chat turn and persists the session', async ({ page }) => {
  await page.goto('/');

  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();
  await composer.fill('hello from e2e');

  await page.getByRole('button', { name: 'Send' }).click();

  // The mock streams two assistant `text` frames, each rendered as its own
  // markdown block inside the assistant message bubble.
  const assistant = page.locator('.chat-message.assistant');
  await expect(assistant.getByText('the mock provider.', { exact: false })).toBeVisible();
  await expect(assistant.getByText('Hello from', { exact: false })).toBeVisible();

  // Terminal `complete`: the composer's Stop affordance is gone (the run is no
  // longer streaming) and the Send control is back.
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

  // Sending the first message created a session and navigated to its deep link.
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]{36}$/);
  const sessionId = page.url().split('/session/')[1];

  // The new session is listed in the sidebar and reachable at /session/:id.
  await expect(page.locator(`a[href="/session/${sessionId}"]`).first()).toBeVisible();
});
