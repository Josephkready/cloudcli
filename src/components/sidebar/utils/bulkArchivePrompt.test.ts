import assert from 'node:assert/strict';
import test from 'node:test';

import type { TFunction } from 'i18next';

import { buildBulkArchivePrompt } from './bulkArchivePrompt';

// A fake `t` that echoes which key was resolved plus the interpolation values,
// so a test can assert both the branch (which key) and that count/days flow
// through. i18next itself owns plural-suffix selection; the helper only picks
// the base key, which is exactly what we verify here.
const t = ((key: string, opts?: Record<string, unknown>) =>
  `${key}|count=${opts?.count ?? ''}|days=${opts?.days ?? ''}`) as unknown as TFunction;

test('a known positive count asks for confirmation naming the count and age', () => {
  const prompt = buildBulkArchivePrompt(14, 30, t);

  assert.equal(prompt.kind, 'confirm');
  assert.equal(prompt.message, 'archive.bulkByAgeConfirmCount|count=14|days=30');
});

test('a zero count informs (does not confirm) so a no-op never runs', () => {
  const prompt = buildBulkArchivePrompt(0, 7, t);

  assert.equal(prompt.kind, 'inform');
  assert.equal(prompt.message, 'archive.bulkByAgeNoneIdle|count=|days=7');
});

test('an unknown count (preview failed) falls back to the generic confirmation', () => {
  const prompt = buildBulkArchivePrompt(null, 90, t);

  assert.equal(prompt.kind, 'confirm');
  // Generic copy carries no count — only the age.
  assert.equal(prompt.message, 'archive.bulkByAgeConfirm|count=|days=90');
});

test('a single-conversation count is still a confirm with count=1 (plural handled by i18next)', () => {
  const prompt = buildBulkArchivePrompt(1, 30, t);

  assert.equal(prompt.kind, 'confirm');
  assert.equal(prompt.message, 'archive.bulkByAgeConfirmCount|count=1|days=30');
});
