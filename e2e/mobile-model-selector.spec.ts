import type { Locator } from '@playwright/test';

import { test, expect } from './fixtures';

test.use({
  viewport: { width: 390, height: 500 },
  hasTouch: true,
  isMobile: true,
});

test('keeps both model selectors usable in a keyboard-constrained mobile viewport', async ({ page }) => {
  await page.goto('/');

  const composer = page.locator('[data-slot="prompt-input-textarea"]');
  await expect(composer).toBeVisible();

  await page.getByText('Click to change model').click();

  const preSessionDialog = page.getByRole('dialog');
  const preSessionSearch = page.getByPlaceholder('Search models...');
  await expect(preSessionDialog).toBeVisible();
  await expect(preSessionSearch).not.toBeFocused();
  // 85dvh of the 500px viewport keeps the bottom sheet clear of browser chrome.
  await expect(preSessionDialog).toHaveCSS('max-height', '425px');

  const cdp = await page.context().newCDPSession(page);
  const swipeUp = async (target: Locator) => {
    const box = await target.boundingBox();
    if (!box) throw new Error('Expected a visible scroll target');

    const x = box.x + box.width / 2;
    const startY = box.y + box.height - 24;
    const endY = box.y + 24;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: startY }],
    });
    for (let step = 1; step <= 6; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: startY + ((endY - startY) * step) / 6 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(150);
  };

  const preSessionList = preSessionDialog.locator('[cmdk-list]');
  const preSessionGeometry = await preSessionList.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(preSessionGeometry.clientHeight).toBeGreaterThan(200);
  expect(preSessionGeometry.scrollHeight).toBeGreaterThan(preSessionGeometry.clientHeight);
  await swipeUp(preSessionList);
  expect(await preSessionList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');

  await composer.fill('/mod');
  await page.getByRole('option', { name: /models/i }).click();

  const modelsDialog = page.getByRole('dialog');
  const scrollRegion = page.getByTestId('model-selector-scroll-region');
  await expect(modelsDialog).toBeVisible();

  const dialogBox = await modelsDialog.boundingBox();
  expect(dialogBox?.height).toBe(500);

  const geometry = await scrollRegion.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(geometry.clientHeight).toBeGreaterThan(250);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  await swipeUp(scrollRegion);
  expect(await scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const lastModel = page.getByRole('button', { name: /^Select model / }).last();
  await lastModel.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  await expect(lastModel).toBeVisible();
  expect(await scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const selectedModel = (await lastModel.getAttribute('aria-label'))?.replace('Select model ', '');
  await lastModel.click();
  await expect(page.getByText(`Default Claude model set to ${selectedModel}.`)).toBeVisible();
});
