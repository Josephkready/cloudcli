import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANTIGRAVITY_FALLBACK_MODELS,
  parseAntigravityModelsStdout,
} from './antigravity-models.provider.js';

test('parseAntigravityModelsStdout preserves current agy model ids and removes duplicates', () => {
  const result = parseAntigravityModelsStdout([
    'gemini-3.6-flash-high',
    'gemini-3.6-flash-low',
    'gemini-3.6-flash-high',
    '',
  ].join('\n'));

  assert.equal(result.DEFAULT, 'gemini-3.6-flash-high');
  assert.deepEqual(
    result.OPTIONS.map((option) => option.value),
    ['gemini-3.6-flash-high', 'gemini-3.6-flash-low'],
  );
});

test('parseAntigravityModelsStdout falls back when agy returns no models', () => {
  assert.deepEqual(parseAntigravityModelsStdout('\n'), ANTIGRAVITY_FALLBACK_MODELS);
});
