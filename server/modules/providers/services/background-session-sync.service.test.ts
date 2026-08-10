import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

import { requestBackgroundSessionSynchronization } from './background-session-sync.service.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'background-sync-'));

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

/** Registers a fake open websocket client and returns the frames sent to it. */
function captureBroadcasts(): { frames: string[]; restore: () => void } {
  const frames: string[] = [];
  const client = {
    readyState: WS_OPEN_STATE,
    send: (message: string) => {
      frames.push(message);
    },
  } as unknown as RealtimeClientConnection;

  connectedClients.add(client);
  return { frames, restore: () => connectedClients.delete(client) };
}

function stubProviderScans(processedPerProvider: number): void {
  for (const provider of providerRegistry.listProviders()) {
    mock.method(provider.sessionSynchronizer, 'synchronize', async () => processedPerProvider);
  }
}

// The snapshot-first projects response (#302) is only correct if clients hear
// about what the background scan found — otherwise a session written while the
// server was down stays invisible until a manual reload.
test('a background sync that indexes sessions tells clients the snapshot is stale', async () => {
  await withIsolatedDatabase(async () => {
    const broadcasts = captureBroadcasts();
    stubProviderScans(2);

    try {
      await requestBackgroundSessionSynchronization();

      assert.equal(broadcasts.frames.length, 1, 'exactly one staleness signal per scan');
      const frame = JSON.parse(broadcasts.frames[0] as string) as { kind: string; timestamp: string };
      assert.equal(frame.kind, 'projects_snapshot_stale');
      assert.ok(frame.timestamp, 'the frame carries a timestamp like every other envelope');
    } finally {
      broadcasts.restore();
      mock.restoreAll();
    }
  });
});

// A scan that changed nothing is the common case on a warm restart. Signalling
// it would make every client refetch the whole project list for no reason.
test('a background sync that indexes nothing stays silent', async () => {
  await withIsolatedDatabase(async () => {
    const broadcasts = captureBroadcasts();
    stubProviderScans(0);

    try {
      await requestBackgroundSessionSynchronization();
      assert.deepEqual(broadcasts.frames, []);
    } finally {
      broadcasts.restore();
      mock.restoreAll();
    }
  });
});

// Every cold-start request asks for freshness. They must share one scan and
// produce one signal, not one per request.
test('concurrent background sync requests share one scan and one signal', async () => {
  await withIsolatedDatabase(async () => {
    const broadcasts = captureBroadcasts();
    let scanCount = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    for (const provider of providerRegistry.listProviders()) {
      mock.method(provider.sessionSynchronizer, 'synchronize', async () => {
        scanCount += 1;
        await gate;
        return 1;
      });
    }

    try {
      const first = requestBackgroundSessionSynchronization();
      const second = requestBackgroundSessionSynchronization();
      release();
      await Promise.all([first, second]);

      assert.equal(scanCount, providerRegistry.listProviders().length, 'one scan per provider, not two');
      assert.equal(broadcasts.frames.length, 1, 'one staleness signal, not one per caller');
    } finally {
      release();
      broadcasts.restore();
      mock.restoreAll();
    }
  });
});

// A scan that rejects outright (as opposed to a per-provider failure, which
// Promise.allSettled already absorbs) must not wedge the pending slot: every
// later caller would inherit that one dead promise and freshness would stop
// forever. It also must not reject its callers — server startup awaits this.
test('a background sync that throws releases the slot and stays silent', async () => {
  await withIsolatedDatabase(async () => {
    const broadcasts = captureBroadcasts();
    mock.method(sessionSynchronizerService, 'synchronizeSessions', async () => {
      throw new Error('scan exploded');
    });

    try {
      const result = await requestBackgroundSessionSynchronization();
      assert.equal(result, null, 'callers see null, not a rejection');
      assert.deepEqual(broadcasts.frames, [], 'a failed scan never claims the snapshot is stale');

      mock.restoreAll();
      stubProviderScans(1);

      // The slot is free again, so the next request produces a real scan.
      await requestBackgroundSessionSynchronization();
      assert.equal(broadcasts.frames.length, 1, 'a later scan still works');
    } finally {
      broadcasts.restore();
      mock.restoreAll();
    }
  });
});
