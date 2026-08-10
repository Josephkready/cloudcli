import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';

import { sessionSynchronizerService } from './session-synchronizer.service.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-sync-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type Deferred = { promise: Promise<number>; resolve: () => void };

function createDeferred(): Deferred {
  let resolveFn: () => void = () => {};
  const promise = new Promise<number>((resolve) => {
    resolveFn = () => resolve(0);
  });
  return { promise, resolve: resolveFn };
}

/**
 * Replaces every registered provider's full-rescan entry point with a stub that
 * blocks until released, and reports how many times it was entered.
 */
function stubProviderScans(gate: Deferred): { scanCount: () => number; restore: () => void } {
  let scanCount = 0;
  for (const provider of providerRegistry.listProviders()) {
    mock.method(provider.sessionSynchronizer, 'synchronize', async () => {
      scanCount += 1;
      await gate.promise;
      return 0;
    });
  }

  return {
    scanCount: () => scanCount,
    restore: () => mock.restoreAll(),
  };
}

// A full rescan is global and idempotent, so overlapping runs duplicate all the
// filesystem work and race each other's last_scanned_at advance. On a cold start
// the server accepts requests before the watcher's startup scan finishes, which
// is exactly how two of them used to overlap (#302).
test('synchronizeSessions coalesces concurrent callers into one scan', async () => {
  await withIsolatedDatabase(async () => {
    const gate = createDeferred();
    const stub = stubProviderScans(gate);

    try {
      const first = sessionSynchronizerService.synchronizeSessions();
      const second = sessionSynchronizerService.synchronizeSessions();

      assert.equal(
        stub.scanCount(),
        providerRegistry.listProviders().length,
        'the second caller must join the in-flight scan, not start another one',
      );
      gate.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.deepEqual(firstResult, secondResult, 'joined callers share one result');

      // The slot is released once the run settles, so the next caller rescans
      // rather than being served a cached result forever.
      await sessionSynchronizerService.synchronizeSessions();
      assert.equal(
        stub.scanCount(),
        providerRegistry.listProviders().length * 2,
        'a call made after the run settled starts a fresh scan',
      );
    } finally {
      gate.resolve();
      stub.restore();
    }
  });
});

// Coalescing must not turn into caching: once a scan settles, the next caller
// gets fresh filesystem state.
test('synchronizeSessions starts a new scan after the previous one settles', async () => {
  await withIsolatedDatabase(async () => {
    const gate = createDeferred();
    gate.resolve();
    const stub = stubProviderScans(gate);
    const providerCount = providerRegistry.listProviders().length;

    try {
      await sessionSynchronizerService.synchronizeSessions();
      await sessionSynchronizerService.synchronizeSessions();

      assert.equal(stub.scanCount(), providerCount * 2, 'sequential calls each run a scan');
    } finally {
      stub.restore();
    }
  });
});

// A provider that throws must not wedge the single-flight slot: every later
// caller would otherwise await a permanently rejected promise.
test('synchronizeSessions releases the in-flight slot when a provider fails', async () => {
  await withIsolatedDatabase(async () => {
    for (const provider of providerRegistry.listProviders()) {
      mock.method(provider.sessionSynchronizer, 'synchronize', async () => {
        throw new Error('provider exploded');
      });
    }

    try {
      const result = await sessionSynchronizerService.synchronizeSessions();
      assert.equal(result.failures.length, providerRegistry.listProviders().length);

      // Still usable afterwards: a rejected run must not wedge the slot, or every
      // later caller would await a permanently failed promise.
      const second = await sessionSynchronizerService.synchronizeSessions();
      assert.equal(second.failures.length, providerRegistry.listProviders().length);
    } finally {
      mock.restoreAll();
    }
  });
});
