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
  await expect(preSessionDialog).toHaveCSS('max-height', '425px');
  await page.keyboard.press('Escape');

  await composer.fill('/mod');
  await page.getByRole('option', { name: /models/i }).click();

  const modelsDialog = page.getByRole('dialog');
  const scrollRegion = page.getByTestId('model-selector-scroll-region');
  const options = page.getByTestId('model-selector-options');
  await expect(modelsDialog).toBeVisible();

  const dialogBox = await modelsDialog.boundingBox();
  expect(dialogBox?.height).toBe(500);

  const geometry = await scrollRegion.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(geometry.clientHeight).toBeGreaterThan(250);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  const optionGeometry = await options.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  // Sub-pixel card/grid dimensions can round the scroll box by one CSS pixel.
  expect(optionGeometry.scrollHeight - optionGeometry.clientHeight).toBeLessThanOrEqual(1);

  const lastModel = page.getByRole('button', { name: /^Select model / }).last();
  await lastModel.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  await expect(lastModel).toBeVisible();
  expect(await scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
