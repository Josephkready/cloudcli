import assert from 'node:assert/strict';
import test from 'node:test';

import type { LLMProvider } from '@/shared/types.js';

import {
  pruneOrphanedBrowserMcp,
  ORPHANED_BROWSER_MCP_NAMES,
  BROWSER_MCP_CLEANUP_FLAG,
} from '../services/orphaned-mcp-cleanup.service.js';

type RemoveResult = { provider: LLMProvider; removed: boolean; error?: string };
type RemoveCall = { name: string; scope?: string };

/** In-memory stand-in for appConfigDb (get/set over a Map). */
function fakeConfigStore(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: (key: string) => store.get(key) ?? null,
    set: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

/** Fake providerMcpService that records calls and returns canned results. */
function fakeMcpService(resultsFor: (name: string) => RemoveResult[]) {
  const calls: RemoveCall[] = [];
  return {
    calls,
    removeMcpServerFromAllProviders: async (input: { name: string; scope?: string }) => {
      calls.push({ name: input.name, scope: input.scope });
      return resultsFor(input.name);
    },
  };
}

const silentLogger = { log: () => {}, warn: () => {} };

test('prunes both orphaned names from all providers at user scope, then records the flag', async () => {
  const config = fakeConfigStore();
  const mcp = fakeMcpService(() => [
    { provider: 'claude', removed: true },
    { provider: 'codex', removed: false },
  ]);

  const result = await pruneOrphanedBrowserMcp({ configStore: config, mcpService: mcp, logger: silentLogger });

  // Queries exactly the two known names, always at user scope.
  assert.deepEqual(mcp.calls.map((c) => c.name), [...ORPHANED_BROWSER_MCP_NAMES]);
  assert.ok(mcp.calls.every((c) => c.scope === 'user'), 'every removal must target user scope');

  // Only providers that reported removed:true are surfaced.
  assert.deepEqual(result.removed, ['cloudcli-browser@claude', 'cloudcli-browser-use@claude']);
  assert.equal(result.ran, true);
  assert.equal(result.completed, true);
  assert.equal(result.hadErrors, false);
  assert.equal(config.get(BROWSER_MCP_CLEANUP_FLAG), 'true');
});

test('is a no-op when nothing was registered, but still records the flag', async () => {
  const config = fakeConfigStore();
  const mcp = fakeMcpService(() => [
    { provider: 'claude', removed: false },
    { provider: 'codex', removed: false },
  ]);

  const result = await pruneOrphanedBrowserMcp({ configStore: config, mcpService: mcp, logger: silentLogger });

  assert.deepEqual(result.removed, []);
  assert.equal(result.hadErrors, false);
  assert.equal(config.get(BROWSER_MCP_CLEANUP_FLAG), 'true');
});

test('short-circuits without touching provider configs once the flag is set', async () => {
  const config = fakeConfigStore({ [BROWSER_MCP_CLEANUP_FLAG]: 'true' });
  const mcp = fakeMcpService(() => {
    throw new Error('removeMcpServerFromAllProviders must not be called');
  });

  const result = await pruneOrphanedBrowserMcp({ configStore: config, mcpService: mcp, logger: silentLogger });

  assert.equal(mcp.calls.length, 0);
  assert.equal(result.ran, false);
  assert.equal(result.completed, true);
});

test('withholds the flag when a provider errors, so it retries next boot', async () => {
  const config = fakeConfigStore();
  const mcp = fakeMcpService((name) =>
    name === 'cloudcli-browser'
      ? [{ provider: 'claude' as LLMProvider, removed: false, error: 'EACCES: ~/.claude.json' }]
      : [{ provider: 'claude' as LLMProvider, removed: false }],
  );

  const result = await pruneOrphanedBrowserMcp({ configStore: config, mcpService: mcp, logger: silentLogger });

  assert.equal(result.hadErrors, true);
  assert.equal(result.completed, false);
  assert.equal(config.get(BROWSER_MCP_CLEANUP_FLAG), null, 'flag must NOT be set after an error');
});

test('withholds the flag when a whole removal call throws', async () => {
  const config = fakeConfigStore();
  const mcp = fakeMcpService(() => {
    throw new Error('provider registry unavailable');
  });

  const result = await pruneOrphanedBrowserMcp({ configStore: config, mcpService: mcp, logger: silentLogger });

  assert.equal(result.hadErrors, true);
  // Both names were attempted despite the first throwing.
  assert.equal(mcp.calls.length, 2);
  assert.equal(config.get(BROWSER_MCP_CLEANUP_FLAG), null);
});

test('idempotent: a second call after a clean pass does no work', async () => {
  const config = fakeConfigStore();
  let callCount = 0;
  const mcp = {
    removeMcpServerFromAllProviders: async () => {
      callCount += 1;
      return [{ provider: 'claude' as LLMProvider, removed: false }];
    },
  };

  await pruneOrphanedBrowserMcp({ configStore: config, mcpService: mcp, logger: silentLogger });
  const firstCallCount = callCount;
  const second = await pruneOrphanedBrowserMcp({ configStore: config, mcpService: mcp, logger: silentLogger });

  assert.equal(callCount, firstCallCount, 'no further removal calls on the second run');
  assert.equal(second.ran, false);
});

test('never throws when persisting the flag fails; reports incomplete so it retries', async () => {
  const warnings: string[] = [];
  const capturingLogger = { log: () => {}, warn: (msg: string) => warnings.push(msg) };
  const config = {
    get: () => null,
    set: () => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    },
  };
  const mcp = fakeMcpService(() => [{ provider: 'claude' as LLMProvider, removed: true }]);

  // Must not reject even though configStore.set throws (never-throws contract).
  const result = await pruneOrphanedBrowserMcp({ configStore: config, mcpService: mcp, logger: capturingLogger });

  assert.equal(result.ran, true);
  assert.equal(result.completed, false, 'flag persistence failed, so it is not complete');
  assert.equal(result.hadErrors, true);
  // The removal work still happened and is surfaced.
  assert.deepEqual(result.removed, ['cloudcli-browser@claude', 'cloudcli-browser-use@claude']);
  assert.ok(warnings.some((w) => w.includes('persist cleanup flag')), 'should warn about the failed flag write');
});
