import { test, expect } from './fixtures';

/*
 * #366: on a real mobile viewport the search inputs must autofocus by intent —
 * opening the folder picker is a BROWSE action (no autofocus, so the keyboard
 * doesn't cover the list), while tapping "Search chats" is a SEARCH action (the
 * field focuses so the user can type at once). jsdom cannot exercise this: it
 * doesn't apply the `hidden`/`md:hidden` media queries, so the desktop input
 * isn't actually `display:none` there and the mobile-specific path — the one the
 * bug was reported on — only exists in a real narrow-viewport browser.
 */
test.use({
  viewport: { width: 390, height: 797 },
  hasTouch: true,
  isMobile: true,
});

test('search inputs autofocus by intent, not on browse (#366)', async ({ page }) => {
  await page.goto('/');

  // The sidebar (and its search tools) lives behind the hamburger on mobile.
  await page.getByRole('button', { name: 'Open menu' }).click();

  // Folder picker — a browse action: it must NOT autofocus its search field.
  await page.getByRole('button', { name: /new conversation/i }).click();
  const folderSearch = page.getByPlaceholder(/search folders/i);
  await expect(folderSearch).toBeVisible();
  await expect(folderSearch).not.toBeFocused();
  await page.keyboard.press('Escape');

  // "Search chats" — a search action: the field must focus so typing works at once.
  // The header renders a desktop AND a mobile input with this placeholder; only
  // the mobile one is visible at this width (the other is `display:none`), so
  // scope to the visible field.
  await page.getByRole('button', { name: /search chats/i }).click();
  const conversationSearch = page
    .getByPlaceholder(/search in conversations/i)
    .and(page.locator(':visible'));
  await expect(conversationSearch).toBeFocused();
});
