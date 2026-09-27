import { test, expect } from './fixtures';

/**
 * #541 — a replayed frame must never render twice.
 *
 * Sending the first message of a new session sent several `chat.subscribe`
 * frames within ~100ms, each carrying `lastSeq: 0`, and the server (correctly)
 * replayed the run's buffered frames once per subscribe. Every copy of the
 * first `stream_delta` was appended, so the reply streamed as
 * "one one one one two ...". Once the run completed, that stuttered bubble no
 * longer matched the final `text`, so the transcript kept both: two assistant
 * bubbles for one reply.
 *
 * The fixed mock reply finishes in one tick, before any subscribe lands, so it
 * cannot reach this. `stream:` keeps the run open with its first chunk already
 * sent, which is the window the replays need.
 */
test('streams a new session reply once, with no replayed chunks or duplicate bubble', async ({ page }) => {
  await page.goto('/');

  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();
  await composer.fill('stream:go');
  await page.getByRole('button', { name: 'Send' }).click();

  // Terminal `complete`: the run is over and every frame has been handled.
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 15_000 });

  // Before the fix this rendered two blocks inside the reply:
  // "one one one one two three four five six" and "one two three four five six".
  const assistant = page.locator('.chat-message.assistant');
  const reply = assistant.getByText('one two three four five six', { exact: false });
  await expect(reply).toHaveCount(1);
  await expect(reply).toHaveText('one two three four five six');
  await expect(assistant).not.toContainText('one one');
});
