import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANTIGRAVITY_EFFORT_TIERS,
  ANTIGRAVITY_FALLBACK_MODELS,
  parseAntigravityModelsStdout,
  splitAntigravitySlug,
} from './antigravity-models.provider.js';

// The real `agy models` output: `<slug>\t<Human label>` per line, tiers encoded
// as a slug suffix. Used as the fixture so the parser is tested against the
// exact shape the CLI emits.
const REAL_AGY_MODELS_STDOUT = [
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
  'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
  'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
  'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
  'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
  'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
  'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n');

test('splitAntigravitySlug separates the base family from the reasoning tier', () => {
  assert.deepEqual(splitAntigravitySlug('gemini-3.8-flash-high'), { base: 'gemini-3.8-flash', effort: 'high' });
  assert.deepEqual(splitAntigravitySlug('gemini-3.1-pro-low'), { base: 'gemini-3.1-pro', effort: 'low' });
  // No tier suffix -> whole slug is the base, no effort.
  assert.deepEqual(splitAntigravitySlug('claude-sonnet-4-6'), { base: 'claude-sonnet-4-6', effort: null });
  // A trailing word that isn't a tier ('thinking') is part of the base.
  assert.deepEqual(splitAntigravitySlug('claude-opus-4-6-thinking'), { base: 'claude-opus-4-6-thinking', effort: null });
});

test('parseAntigravityModelsStdout collapses tiered slugs into base models with effort tiers', () => {
  const result = parseAntigravityModelsStdout(REAL_AGY_MODELS_STDOUT);

  // One option per base family, tiers no longer in the model list.
  assert.deepEqual(
    result.OPTIONS.map((option) => option.value),
    ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-pro', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b'],
  );
  assert.equal(result.DEFAULT, 'gemini-3.8-flash');

  const byValue = new Map(result.OPTIONS.map((option) => [option.value, option]));
  // Gemini flash: full low/medium/high, default medium.
  assert.deepEqual(byValue.get('gemini-3.8-flash')?.effort?.values.map((v) => v.value), ['low', 'medium', 'high']);
  assert.equal(byValue.get('gemini-3.8-flash')?.effort?.default, 'medium');
  // 3.1 Pro has no medium tier; default falls through to high.
  assert.deepEqual(byValue.get('gemini-3.1-pro')?.effort?.values.map((v) => v.value), ['low', 'high']);
  assert.equal(byValue.get('gemini-3.1-pro')?.effort?.default, 'high');
  // gpt-oss-120b is medium-only.
  assert.deepEqual(byValue.get('gpt-oss-120b')?.effort?.values.map((v) => v.value), ['medium']);
  // Claude-on-Antigravity models carry NO effort object -> picker hides the effort selector.
  assert.equal(byValue.get('claude-sonnet-4-6')?.effort, undefined);
  assert.equal(byValue.get('claude-opus-4-6-thinking')?.effort, undefined);
  // The human label drops the tier parenthetical for the base family.
  assert.equal(byValue.get('gemini-3.8-flash')?.label, 'Gemini 3.8 Flash');
  assert.equal(byValue.get('claude-sonnet-4-6')?.label, 'Claude Sonnet 4.6 (Thinking)');
});

// REGRESSION (#492): the original parser passed the whole `<slug>\t<label>` line
// as the model value, so `agy --model "<slug>\t<label>"` was rejected as "Invalid
// model". Every model value the picker exposes must be a bare `agy --model`
// token — no tab, no space, no parentheses. This fails loudly on that bug.
test('every exposed antigravity model value is a valid agy --model token (#492)', () => {
  for (const definition of [parseAntigravityModelsStdout(REAL_AGY_MODELS_STDOUT), ANTIGRAVITY_FALLBACK_MODELS]) {
    for (const option of definition.OPTIONS) {
      assert.match(option.value, /^[a-z0-9.-]+$/, `invalid model token: ${JSON.stringify(option.value)}`);
    }
    assert.ok(
      definition.OPTIONS.some((option) => option.value === definition.DEFAULT),
      'DEFAULT must be one of OPTIONS',
    );
  }
});

// REGRESSION (#492): the model + effort split must be lossless — every
// (base model, effort tier) pair the UI can produce has to reconstruct a slug
// that was in the real `agy models` catalog, and every catalog slug has to be
// reachable. A drift here means the picker can offer a combination `agy` rejects.
test('base model + effort tier round-trips to a real agy catalog slug (#492)', () => {
  const catalogSlugs = new Set(
    REAL_AGY_MODELS_STDOUT.split('\n').map((line) => line.split('\t')[0]),
  );
  const reachable = new Set<string>();

  for (const option of parseAntigravityModelsStdout(REAL_AGY_MODELS_STDOUT).OPTIONS) {
    const tiers = option.effort?.values.map((v) => v.value) ?? [];
    if (tiers.length === 0) {
      assert.ok(catalogSlugs.has(option.value), `untiered model not in catalog: ${option.value}`);
      reachable.add(option.value);
      continue;
    }
    for (const tier of tiers) {
      const slug = `${option.value}-${tier}`;
      assert.ok(catalogSlugs.has(slug), `reconstructed slug not in catalog: ${slug}`);
      reachable.add(slug);
    }
    // The effort default must itself be an offered tier.
    assert.ok(tiers.includes(option.effort!.default!), `default tier not offered: ${option.value}`);
  }

  // No catalog slug is dropped by the grouping.
  assert.deepEqual([...reachable].sort(), [...catalogSlugs].sort());
});

test('effort tiers offered are a subset of what agy --effort accepts', () => {
  const accepted = new Set<string>(ANTIGRAVITY_EFFORT_TIERS);
  for (const option of ANTIGRAVITY_FALLBACK_MODELS.OPTIONS) {
    for (const value of option.effort?.values ?? []) {
      assert.ok(accepted.has(value.value), `unknown effort tier: ${value.value}`);
    }
  }
});

test('parseAntigravityModelsStdout still supports legacy slug-only output', () => {
  const result = parseAntigravityModelsStdout(['gemini-3.6-flash-high', 'gemini-3.6-flash-low', ''].join('\n'));
  assert.deepEqual(result.OPTIONS.map((option) => option.value), ['gemini-3.6-flash']);
  assert.deepEqual(result.OPTIONS[0].effort?.values.map((v) => v.value), ['low', 'high']);
});

test('parseAntigravityModelsStdout falls back when agy returns no models', () => {
  assert.deepEqual(parseAntigravityModelsStdout('\n'), ANTIGRAVITY_FALLBACK_MODELS);
});

test('ANTIGRAVITY_FALLBACK_MODELS carries no removed gemini-3.5-flash ids (#492)', () => {
  const values = ANTIGRAVITY_FALLBACK_MODELS.OPTIONS.map((option) => option.value);
  assert.ok(!values.some((value) => value.startsWith('gemini-3.5')), 'gemini-3.5-* was removed upstream');
});
