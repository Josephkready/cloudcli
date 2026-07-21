import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ProviderModelsDefinition } from '@/shared/types.js';

// `codex-models.provider.ts` resolves ~/.codex/models_cache.json and
// ~/.codex/config.toml into module-level constants at import time, so the home
// directory has to be redirected *before* the module is first loaded. Every
// `await import(...)` below therefore resolves to the same already-initialised
// module instance pointing at this fixture home.
const codexHome = mkdtempSync(path.join(os.tmpdir(), 'codex-models-home-'));
const codexDir = path.join(codexHome, '.codex');
mkdirSync(codexDir, { recursive: true });
(os as unknown as { homedir: () => string }).homedir = () => codexHome;

const modelsCachePath = path.join(codexDir, 'models_cache.json');
const configPath = path.join(codexDir, 'config.toml');

type ProviderModule = typeof import('@/modules/providers/list/codex/codex-models.provider.js');

const loadProvider = async (): Promise<ProviderModule> => (
  import('@/modules/providers/list/codex/codex-models.provider.js')
);

const listedModel = (overrides: Record<string, unknown> = {}) => ({
  visibility: 'list',
  supported_in_api: true,
  ...overrides,
});

// ---------------------------------------------------------------------------
// buildCodexModelsDefinition — golden output
// ---------------------------------------------------------------------------

test('buildCodexModelsDefinition maps a realistic cache to the picker catalogue', async () => {
  const { buildCodexModelsDefinition } = await loadProvider();

  const definition = buildCodexModelsDefinition([
    listedModel({
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      description: 'Most capable',
      priority: 10,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fastest' },
        { effort: 'medium' },
        { effort: 'high', description: 'Deepest' },
      ],
    }),
    listedModel({ slug: 'gpt-5.4-mini', priority: 20 }),
  ]);

  const expected: ProviderModelsDefinition = {
    OPTIONS: [
      {
        value: 'gpt-5.5',
        label: 'GPT-5.5',
        description: 'Most capable',
        effort: {
          default: 'medium',
          values: [
            { value: 'low', description: 'Fastest' },
            { value: 'medium', description: undefined },
            { value: 'high', description: 'Deepest' },
          ],
        },
      },
      {
        value: 'gpt-5.4-mini',
        label: 'gpt-5.4-mini',
        description: undefined,
        effort: undefined,
      },
    ],
    DEFAULT: 'gpt-5.5',
  };

  assert.deepEqual(definition, expected);
});

test('buildCodexModelsDefinition orders models by priority, unprioritised last', async () => {
  const { buildCodexModelsDefinition } = await loadProvider();

  const definition = buildCodexModelsDefinition([
    listedModel({ slug: 'third', priority: 30 }),
    listedModel({ slug: 'unranked' }),
    listedModel({ slug: 'first', priority: 1 }),
    listedModel({ slug: 'second', priority: 2 }),
    listedModel({ slug: 'not-a-number', priority: Number.NaN }),
  ]);

  assert.deepEqual(
    definition.OPTIONS.map((option) => option.value),
    ['first', 'second', 'third', 'unranked', 'not-a-number'],
  );
  assert.equal(definition.DEFAULT, 'first', 'the highest-priority model becomes the default');
});

test('buildCodexModelsDefinition hides models the picker must not offer', async () => {
  const { buildCodexModelsDefinition } = await loadProvider();

  const definition = buildCodexModelsDefinition([
    listedModel({ slug: 'visible', priority: 1 }),
    listedModel({ slug: 'hidden', visibility: 'hidden', priority: 0 }),
    listedModel({ slug: 'no-visibility', visibility: undefined, priority: 0 }),
    listedModel({ slug: 'api-unsupported', supported_in_api: false, priority: 0 }),
  ]);

  assert.deepEqual(definition.OPTIONS.map((option) => option.value), ['visible']);
});

test('buildCodexModelsDefinition keeps the first entry of a duplicated slug', async () => {
  const { buildCodexModelsDefinition } = await loadProvider();

  const definition = buildCodexModelsDefinition([
    listedModel({ slug: 'gpt-5.5', display_name: 'Winner', priority: 1 }),
    listedModel({ slug: 'gpt-5.5', display_name: 'Loser', priority: 2 }),
  ]);

  assert.equal(definition.OPTIONS.length, 1);
  assert.equal(definition.OPTIONS[0].label, 'Winner');
});

test('buildCodexModelsDefinition drops reasoning levels with no effort value', async () => {
  const { buildCodexModelsDefinition } = await loadProvider();

  const definition = buildCodexModelsDefinition([
    listedModel({
      slug: 'gpt-5.5',
      supported_reasoning_levels: [{ description: 'no effort key' }, { effort: 'high' }],
    }),
  ]);

  assert.deepEqual(definition.OPTIONS[0].effort?.values, [{ value: 'high', description: undefined }]);
});

test('buildCodexModelsDefinition omits effort entirely when no level survives', async () => {
  const { buildCodexModelsDefinition } = await loadProvider();

  const definition = buildCodexModelsDefinition([
    listedModel({ slug: 'gpt-5.5', supported_reasoning_levels: [{ description: 'malformed' }] }),
    listedModel({ slug: 'gpt-5.4', supported_reasoning_levels: 'not-an-array' }),
  ]);

  assert.equal(definition.OPTIONS[0].effort, undefined);
  assert.equal(definition.OPTIONS[1].effort, undefined);
});

test('buildCodexModelsDefinition falls back when every model is filtered out', async () => {
  const { buildCodexModelsDefinition, CODEX_FALLBACK_MODELS } = await loadProvider();

  assert.deepEqual(buildCodexModelsDefinition([]), CODEX_FALLBACK_MODELS);
  assert.deepEqual(
    buildCodexModelsDefinition([listedModel({ slug: 'hidden', visibility: 'hidden' })]),
    CODEX_FALLBACK_MODELS,
  );
});

// ---------------------------------------------------------------------------
// getSupportedModels — cache file reading + fallback path
// ---------------------------------------------------------------------------

test('getSupportedModels reads the on-disk Codex model cache', { concurrency: false }, async () => {
  const { CodexProviderModels } = await loadProvider();

  await writeFile(modelsCachePath, JSON.stringify({
    models: [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 1 },
      { slug: 'gpt-5.4', visibility: 'list', priority: 2 },
    ],
  }), 'utf8');

  try {
    const models = await new CodexProviderModels().getSupportedModels();
    assert.deepEqual(models.OPTIONS.map((option) => option.value), ['gpt-5.5', 'gpt-5.4']);
    assert.equal(models.DEFAULT, 'gpt-5.5');
  } finally {
    await rm(modelsCachePath, { force: true });
  }
});

test('getSupportedModels falls back when the cache is missing', { concurrency: false }, async () => {
  const { CodexProviderModels, CODEX_FALLBACK_MODELS } = await loadProvider();

  await rm(modelsCachePath, { force: true });
  assert.deepEqual(await new CodexProviderModels().getSupportedModels(), CODEX_FALLBACK_MODELS);
});

test('getSupportedModels falls back on unparseable or unexpected cache contents', { concurrency: false }, async () => {
  const { CodexProviderModels, CODEX_FALLBACK_MODELS } = await loadProvider();
  const provider = new CodexProviderModels();

  try {
    // A half-written cache file must not take the model picker down.
    await writeFile(modelsCachePath, '{ "models": [', 'utf8');
    assert.deepEqual(await provider.getSupportedModels(), CODEX_FALLBACK_MODELS);

    await writeFile(modelsCachePath, JSON.stringify({ models: 'not-an-array' }), 'utf8');
    assert.deepEqual(await provider.getSupportedModels(), CODEX_FALLBACK_MODELS);

    await writeFile(modelsCachePath, JSON.stringify([{ slug: 'gpt-5.5' }]), 'utf8');
    assert.deepEqual(await provider.getSupportedModels(), CODEX_FALLBACK_MODELS);
  } finally {
    await rm(modelsCachePath, { force: true });
  }
});

test('getSupportedModels ignores cache entries with no slug', { concurrency: false }, async () => {
  const { CodexProviderModels } = await loadProvider();

  await writeFile(modelsCachePath, JSON.stringify({
    models: [
      { display_name: 'Slugless', visibility: 'list', priority: 1 },
      null,
      'garbage',
      { slug: 'gpt-5.5', visibility: 'list', priority: 2 },
    ],
  }), 'utf8');

  try {
    const models = await new CodexProviderModels().getSupportedModels();
    assert.deepEqual(models.OPTIONS.map((option) => option.value), ['gpt-5.5']);
  } finally {
    await rm(modelsCachePath, { force: true });
  }
});

// ---------------------------------------------------------------------------
// getCurrentActiveModel — config.toml reading + fallback path
// ---------------------------------------------------------------------------

test('getCurrentActiveModel reads the model out of config.toml', { concurrency: false }, async () => {
  const { CodexProviderModels } = await loadProvider();

  await writeFile(configPath, 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n', 'utf8');

  try {
    assert.deepEqual(await new CodexProviderModels().getCurrentActiveModel(), { model: 'gpt-5.5' });
  } finally {
    await rm(configPath, { force: true });
  }
});

test('getCurrentActiveModel falls back to the catalogue default when config.toml has no model', { concurrency: false }, async () => {
  const { CodexProviderModels, CODEX_FALLBACK_MODELS } = await loadProvider();
  const provider = new CodexProviderModels();

  await rm(modelsCachePath, { force: true });

  try {
    await writeFile(configPath, 'approval_policy = "on-request"\n', 'utf8');
    assert.deepEqual(await provider.getCurrentActiveModel(), { model: CODEX_FALLBACK_MODELS.DEFAULT });

    // Malformed TOML takes the same path rather than throwing at the caller.
    await writeFile(configPath, 'model = "unterminated\n', 'utf8');
    assert.deepEqual(await provider.getCurrentActiveModel(), { model: CODEX_FALLBACK_MODELS.DEFAULT });

    await rm(configPath, { force: true });
    assert.deepEqual(await provider.getCurrentActiveModel(), { model: CODEX_FALLBACK_MODELS.DEFAULT });
  } finally {
    await rm(configPath, { force: true });
  }
});

test('getCurrentActiveModel falls back to the cached catalogue default, not the hardcoded one', { concurrency: false }, async () => {
  const { CodexProviderModels } = await loadProvider();

  await writeFile(modelsCachePath, JSON.stringify({
    models: [{ slug: 'gpt-6-preview', visibility: 'list', priority: 1 }],
  }), 'utf8');
  await rm(configPath, { force: true });

  try {
    assert.deepEqual(await new CodexProviderModels().getCurrentActiveModel(), { model: 'gpt-6-preview' });
  } finally {
    await rm(modelsCachePath, { force: true });
  }
});

test.after(async () => {
  await rm(codexHome, { recursive: true, force: true });
});
