import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANTIGRAVITY_FALLBACK_MODELS,
  parseAntigravityModelsStdout,
} from './antigravity-models.provider.js';

test('parseAntigravityModelsStdout takes the slug from tab-delimited `slug<TAB>label` output (#492)', () => {
  // Real `agy models` stdout: one `<slug>\t<Human label>` per line.
  const result = parseAntigravityModelsStdout([
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  ].join('\n'));

  // The value must be the bare slug — passing the whole line to `agy --model`
  // is what produced "Invalid model".
  assert.deepEqual(
    result.OPTIONS.map((option) => option.value),
    ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'claude-sonnet-4-6'],
  );
  // The human label is surfaced to the picker when present.
  assert.deepEqual(
    result.OPTIONS.map((option) => option.label),
    ['Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Medium)', 'Claude Sonnet 4.6 (Thinking)'],
  );
  assert.equal(result.DEFAULT, 'gemini-3.8-flash-high');
});

test('parseAntigravityModelsStdout still supports legacy slug-only output and dedupes', () => {
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
  // With no label column the slug doubles as the label.
  assert.deepEqual(
    result.OPTIONS.map((option) => option.label),
    ['gemini-3.6-flash-high', 'gemini-3.6-flash-low'],
  );
});

test('parseAntigravityModelsStdout falls back when agy returns no models', () => {
  assert.deepEqual(parseAntigravityModelsStdout('\n'), ANTIGRAVITY_FALLBACK_MODELS);
});

test('ANTIGRAVITY_FALLBACK_MODELS carries no removed gemini-3.5-flash ids (#492)', () => {
  const values = ANTIGRAVITY_FALLBACK_MODELS.OPTIONS.map((option) => option.value);
  assert.ok(!values.some((value) => value.startsWith('gemini-3.5-flash')), 'gemini-3.5-flash-* was removed upstream');
  assert.ok(values.includes(ANTIGRAVITY_FALLBACK_MODELS.DEFAULT), 'DEFAULT must be one of OPTIONS');
});
