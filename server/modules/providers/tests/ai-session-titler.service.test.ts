import assert from 'node:assert/strict';
import test from 'node:test';

import {
  processTitleBatch,
  type TitleBatchDeps,
} from '@/modules/providers/services/ai-session-titler.service.js';

/**
 * Records every collaborator call so the batch's ordering/marking invariants can
 * be asserted. `generate` is driven by a per-session_id script.
 */
function makeDeps(script: Record<string, string | null | Error>): {
  deps: TitleBatchDeps;
  persisted: Array<{ id: string; title: string }>;
  broadcasts: string[];
  generatedFor: string[];
} {
  const persisted: Array<{ id: string; title: string }> = [];
  const broadcasts: string[] = [];
  const generatedFor: string[] = [];

  const deps: TitleBatchDeps = {
    generate: async (raw) => {
      generatedFor.push(raw);
      const outcome = script[raw];
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome ?? null;
    },
    persist: (id, title) => {
      persisted.push({ id, title });
    },
    broadcast: async (id) => {
      broadcasts.push(id);
    },
  };

  return { deps, persisted, broadcasts, generatedFor };
}

test('processTitleBatch rewrites and broadcasts a good title', async () => {
  const { deps, persisted, broadcasts } = makeDeps({ 'raw one': 'Short One' });
  const result = await processTitleBatch([{ session_id: 's1', custom_name: 'raw one' }], deps);

  assert.deepEqual(persisted, [{ id: 's1', title: 'Short One' }]);
  assert.deepEqual(broadcasts, ['s1']);
  assert.deepEqual(result, { rewritten: 1, attempted: 1, failed: false });
});

test('processTitleBatch marks a null-result row done (keeping the raw title) without broadcasting', async () => {
  // Guards the "a stubborn row can't starve the backfill" invariant: an
  // unusable model result must still persist name_source='ai' so the row is
  // not re-picked forever.
  const { deps, persisted, broadcasts } = makeDeps({ 'raw two': null });
  const result = await processTitleBatch([{ session_id: 's2', custom_name: 'raw two' }], deps);

  assert.deepEqual(persisted, [{ id: 's2', title: 'raw two' }]);
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(result, { rewritten: 0, attempted: 1, failed: false });
});

test('processTitleBatch does not broadcast when the model echoes the raw title', async () => {
  const { deps, persisted, broadcasts } = makeDeps({ 'raw same': 'raw same' });
  const result = await processTitleBatch([{ session_id: 's3', custom_name: 'raw same' }], deps);

  assert.deepEqual(persisted, [{ id: 's3', title: 'raw same' }]);
  assert.deepEqual(broadcasts, []);
  assert.equal(result.rewritten, 0);
});

test('processTitleBatch skips rows with no custom_name without attempting generation', async () => {
  const { deps, persisted, generatedFor } = makeDeps({});
  const result = await processTitleBatch([{ session_id: 's4', custom_name: null }], deps);

  assert.deepEqual(persisted, []);
  assert.deepEqual(generatedFor, []);
  assert.deepEqual(result, { rewritten: 0, attempted: 0, failed: false });
});

test('processTitleBatch aborts the rest of the batch when generation throws', async () => {
  const { deps, persisted, generatedFor } = makeDeps({
    'raw a': 'Title A',
    'raw b': new Error('ollama down'),
    'raw c': 'Title C',
  });

  const result = await processTitleBatch(
    [
      { session_id: 'a', custom_name: 'raw a' },
      { session_id: 'b', custom_name: 'raw b' },
      { session_id: 'c', custom_name: 'raw c' },
    ],
    deps,
  );

  // First row succeeded; the throw on the second stops processing before the third.
  assert.deepEqual(persisted, [{ id: 'a', title: 'Title A' }]);
  assert.deepEqual(generatedFor, ['raw a', 'raw b']);
  assert.deepEqual(result, { rewritten: 1, attempted: 2, failed: true });
});

test('processTitleBatch continues the batch when a broadcast fails', async () => {
  const { deps, persisted, broadcasts } = makeDeps({ 'raw x': 'Title X', 'raw y': 'Title Y' });
  deps.broadcast = async (id) => {
    broadcasts.push(id);
    if (id === 'x') {
      throw new Error('client gone');
    }
  };

  const result = await processTitleBatch(
    [
      { session_id: 'x', custom_name: 'raw x' },
      { session_id: 'y', custom_name: 'raw y' },
    ],
    deps,
  );

  // Both titles persisted and counted even though x's broadcast threw.
  assert.deepEqual(persisted, [
    { id: 'x', title: 'Title X' },
    { id: 'y', title: 'Title Y' },
  ]);
  assert.deepEqual(broadcasts, ['x', 'y']);
  assert.deepEqual(result, { rewritten: 2, attempted: 2, failed: false });
});
