import { appConfigDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';

/**
 * One-time cleanup of the MCP registration left behind by the removed
 * browser-use feature (#79 / PR #93; follow-up #95).
 *
 * When the opt-in, default-off Browser setting was toggled on, the old
 * browser-use service persisted a `cloudcli-browser` stdio MCP server (and,
 * historically, the legacy `cloudcli-browser-use`) into every provider's
 * *user*-scope config (e.g. `~/.claude.json` `mcpServers`, the Codex
 * equivalent, etc.). Its command now points at a deleted script, so the
 * provider CLI fails to spawn it on every session and it lingers in the user's
 * MCP list.
 *
 * This prunes those entries once and records a flag in `appConfigDb` so we
 * don't rescan/rewrite provider configs on every boot. Removing an absent
 * entry is a no-op, so it is safe on installs that never enabled the feature.
 */

export const ORPHANED_BROWSER_MCP_NAMES = ['cloudcli-browser', 'cloudcli-browser-use'] as const;
export const BROWSER_MCP_CLEANUP_FLAG = 'browser_use_mcp_cleanup_done';

type CleanupDeps = {
  configStore?: Pick<typeof appConfigDb, 'get' | 'set'>;
  mcpService?: Pick<typeof providerMcpService, 'removeMcpServerFromAllProviders'>;
  logger?: Pick<Console, 'log' | 'warn'>;
};

export type BrowserMcpCleanupResult = {
  /** false when skipped because the cleanup already ran on a prior boot. */
  ran: boolean;
  /** true once the "done" flag is (or already was) recorded. */
  completed: boolean;
  /** `name@provider` entries that were actually removed this run. */
  removed: string[];
  /** true if any provider errored — the flag is withheld so it retries. */
  hadErrors: boolean;
};

/**
 * Idempotent. Runs at most once per install (guarded by the config flag);
 * a second call after a clean pass short-circuits without touching provider
 * configs. Never throws — failures are logged and cause a retry next boot.
 */
export async function pruneOrphanedBrowserMcp(deps: CleanupDeps = {}): Promise<BrowserMcpCleanupResult> {
  const configStore = deps.configStore ?? appConfigDb;
  const mcpService = deps.mcpService ?? providerMcpService;
  const logger = deps.logger ?? console;

  if (configStore.get(BROWSER_MCP_CLEANUP_FLAG) === 'true') {
    return { ran: false, completed: true, removed: [], hadErrors: false };
  }

  const removed: string[] = [];
  let hadErrors = false;

  for (const name of ORPHANED_BROWSER_MCP_NAMES) {
    let results;
    try {
      // Scope 'user' mirrors how browser-use originally registered the server.
      results = await mcpService.removeMcpServerFromAllProviders({ name, scope: 'user' });
    } catch (error) {
      hadErrors = true;
      logger.warn(`[MCP cleanup] Failed to prune '${name}': ${(error as Error)?.message ?? String(error)}`);
      continue;
    }

    for (const result of results) {
      if (result.error) {
        hadErrors = true;
        logger.warn(`[MCP cleanup] ${result.provider}: could not prune '${name}': ${result.error}`);
      } else if (result.removed) {
        removed.push(`${name}@${result.provider}`);
      }
    }
  }

  if (removed.length > 0) {
    logger.log(`[MCP cleanup] Removed orphaned browser MCP registration(s): ${removed.join(', ')}`);
  }

  // Only record the flag on a clean pass so transient failures retry next boot.
  if (!hadErrors) {
    try {
      configStore.set(BROWSER_MCP_CLEANUP_FLAG, 'true');
    } catch (error) {
      // The cleanup itself already succeeded; only persisting the flag failed.
      // Swallow it (keeping the never-throws contract) — the next boot simply
      // re-runs, and removing already-absent entries is a harmless no-op.
      hadErrors = true;
      logger.warn(`[MCP cleanup] Could not persist cleanup flag: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  return { ran: true, completed: !hadErrors, removed, hadErrors };
}
