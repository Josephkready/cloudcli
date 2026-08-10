import { scanStateDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';

type SessionSynchronizeResult = {
  processedByProvider: Record<LLMProvider, number>;
  failures: string[];
};

// A full provider rescan is a global, idempotent operation over the same
// transcript roots, so two overlapping runs do identical filesystem work and
// race each other's `scan_state.last_scanned_at` advance. That happened on every
// cold start (#302): `server.listen()` accepts requests before the watcher's
// startup sync finishes, so a browser opened immediately triggered a second
// concurrent scan. Callers now share one in-flight run.
let inFlightSynchronization: Promise<SessionSynchronizeResult> | null = null;

async function runFullSynchronization(): Promise<SessionSynchronizeResult> {
  const lastScanAt = scanStateDb.getLastScannedAt();
  const scanBoundary = new Date();
  const processedByProvider: Record<LLMProvider, number> = {
    claude: 0,
    codex: 0,
    antigravity: 0,
  };
  const failures: string[] = [];

  const results = await Promise.allSettled(
    providerRegistry.listProviders().map(async (provider) => ({
      provider: provider.id,
      processed: await provider.sessionSynchronizer.synchronize(lastScanAt ?? undefined),
    }))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      processedByProvider[result.value.provider] = result.value.processed;
      continue;
    }

    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push(reason);
  }

  if (failures.length === 0) {
    scanStateDb.updateLastScannedAt(scanBoundary);
  } else {
    console.warn(
      `[Sessions] Skipping scan_state last_scanned_at advance because ${failures.length} provider sync(s) failed.`,
    );
  }

  return {
    processedByProvider,
    failures,
  };
}

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 */
export const sessionSynchronizerService = {
  /**
   * Runs all provider synchronizers and updates scan_state.last_scanned_at.
   *
   * Single-flight: a call made while a scan is running joins that scan instead of
   * starting a duplicate one.
   */
  async synchronizeSessions(): Promise<SessionSynchronizeResult> {
    if (inFlightSynchronization) {
      return inFlightSynchronization;
    }

    const run = runFullSynchronization();
    inFlightSynchronization = run;
    try {
      return await run;
    } finally {
      // Only clear our own run: a later caller may already have installed a new one.
      if (inFlightSynchronization === run) {
        inFlightSynchronization = null;
      }
    }
  },

  /**
   * True while a full synchronization is running. Lets callers decide whether to
   * start a background refresh rather than pile onto one already in progress.
   */
  isSynchronizing(): boolean {
    return inFlightSynchronization !== null;
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null }> {
    const resolvedProvider = providerRegistry.resolveProvider(provider);
    const sessionId = await resolvedProvider.sessionSynchronizer.synchronizeFile(filePath);
    return {
      provider,
      indexed: Boolean(sessionId),
      sessionId,
    };
  },
};
