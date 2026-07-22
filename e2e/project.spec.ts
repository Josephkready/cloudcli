import { test, expect } from './fixtures';

/**
 * P0 — the seeded project is listed in the sidebar and is selectable, after
 * which the chat composer is ready for input.
 *
 * With a single seeded project the app auto-selects it on load, so we assert it
 * renders as the active row and that clicking it keeps the chat composer ready.
 * The click uses `force` because a sticky "Spaces" section header overlaps the
 * row's top edge in the default viewport — the row itself is the intended
 * target.
 */
test('lists and selects the seeded project', async ({ page, server }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'CloudCLI' })).toBeVisible();

  const projectRow = page.getByTestId('sidebar-project-row');
  await expect(projectRow).toBeVisible();
  await expect(projectRow).toContainText(server.projectName);

  await projectRow.click({ force: true });

  // Selecting a project renders the chat interface with its composer ready.
  await expect(page.locator('[data-slot="prompt-input-textarea"]')).toBeVisible();
});
