import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * #371: the PWA colours were all hardcoded `#ffffff`, so a dark-mode user got a
 * white flash on every launch — the OS splash (`manifest.background_color`) and
 * the browser/OS chrome (`theme-color`) before the app's own CSS ran. These pin
 * the fix: no white PWA colours, and a light AND dark media-queried `theme-color`
 * so the pre-JS chrome matches the OS scheme.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const WHITE = /^#(fff|ffffff)$/i;

test('the manifest splash/theme colours are not white', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'public/manifest.json'), 'utf8'));
  assert.ok(
    !WHITE.test(manifest.background_color),
    `manifest.background_color must not be white (got ${manifest.background_color})`,
  );
  assert.ok(
    !WHITE.test(manifest.theme_color),
    `manifest.theme_color must not be white (got ${manifest.theme_color})`,
  );
});

test('index.html declares light AND dark media-queried theme-color metas', () => {
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const themeColorMetas = html.match(/<meta[^>]*name="theme-color"[^>]*>/g) ?? [];

  const hasLight = themeColorMetas.some((m) => /prefers-color-scheme:\s*light/.test(m));
  const hasDark = themeColorMetas.some((m) => /prefers-color-scheme:\s*dark/.test(m));
  assert.ok(hasLight, 'expected a theme-color meta gated on prefers-color-scheme: light');
  assert.ok(hasDark, 'expected a theme-color meta gated on prefers-color-scheme: dark');

  // The single unconditional white theme-color meta must be gone.
  const bareWhite = themeColorMetas.some(
    (m) => !/media=/.test(m) && /content="#(fff|ffffff)"/i.test(m),
  );
  assert.ok(!bareWhite, 'the unconditional white theme-color meta must be replaced');
});
