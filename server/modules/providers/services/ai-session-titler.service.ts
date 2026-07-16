/**
 * Background worker that rewrites long "first-prompt" session titles into short
 * ones using a local Ollama model, then broadcasts a live sidebar update.
 *
 * Opt-in and default-off (needs a local Ollama): a no-op unless
 * CLOUDCLI_AI_TITLES_ENABLED=true. Runs a single, sequential drip so a full
 * backfill stays gentle and never overlaps itself. Eligibility (which rows are
 * "raw" and long enough) is decided in SQL by sessionsDb.getSessionsNeedingAiTitle.
 */

import { sessionsDb } from '@/modules/database/index.js';
import { generateShortTitle } from '@/modules/providers/services/ai-title-generator.service.js';
import { broadcastSessionUpserted } from '@/modules/providers/services/sessions-watcher.service.js';

interface TitlerConfig {
  enabled: boolean;
  ollamaUrl: string;
  model: string;
  intervalMs: number;
  batchSize: number;
  minLength: number;
}

/** The subset of a session row the batch processor needs. */
interface TitleCandidate {
  session_id: string;
  custom_name: string | null;
}

/**
 * Injectable collaborators for one batch, so the ordering/marking invariants can
 * be unit-tested without a real DB, Ollama, or WebSocket clients.
 */
export interface TitleBatchDeps {
  generate: (rawTitle: string) => Promise<string | null>;
  /** Persists the final title and marks the row done (name_source = 'ai'). */
  persist: (sessionId: string, title: string) => void;
  broadcast: (sessionId: string) => Promise<void>;
}

export interface TitleBatchResult {
  /** Titles that actually changed (and were broadcast). */
  rewritten: number;
  /** Rows a generation request was attempted for (used to detect recovery). */
  attempted: number;
  /** A generation request threw — Ollama is unhealthy; caller should back off. */
  failed: boolean;
}

// A generation attempt that throws means Ollama is unhealthy; skip up to this
// many subsequent ticks (growing with consecutive failures) so a sustained
// outage is retried with real backoff rather than at the fixed cadence.
const MAX_COOLDOWN_TICKS = 12;

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readConfig(): TitlerConfig {
  return {
    enabled: process.env.CLOUDCLI_AI_TITLES_ENABLED === 'true',
    ollamaUrl: process.env.CLOUDCLI_AI_TITLES_OLLAMA_URL?.trim() || 'http://localhost:11434',
    model: process.env.CLOUDCLI_AI_TITLES_MODEL?.trim() || 'llama3.1:8b',
    intervalMs: positiveIntFromEnv(process.env.CLOUDCLI_AI_TITLES_INTERVAL_MS, 5_000),
    batchSize: positiveIntFromEnv(process.env.CLOUDCLI_AI_TITLES_BATCH, 5),
    minLength: positiveIntFromEnv(process.env.CLOUDCLI_AI_TITLES_MIN_LEN, 60),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rewrites one batch of candidate titles.
 *
 * Every row a request completes for is marked done (`name_source = 'ai'`), even
 * when the model yields nothing usable — in that case the original title is kept
 * — so a stubborn row can never starve the backfill by being re-picked every
 * tick. A row is broadcast only when its title actually changed. A broadcast
 * failure is logged and swallowed (the title is already persisted). A thrown
 * generation request aborts the rest of the batch and reports `failed` so the
 * scheduler can back off.
 */
export async function processTitleBatch(
  rows: TitleCandidate[],
  deps: TitleBatchDeps
): Promise<TitleBatchResult> {
  let rewritten = 0;
  let attempted = 0;

  for (const row of rows) {
    const raw = row.custom_name;
    if (!raw) {
      continue;
    }

    let title: string | null;
    try {
      attempted += 1;
      title = await deps.generate(raw);
    } catch {
      return { rewritten, attempted, failed: true };
    }

    const finalTitle = title && title !== raw ? title : raw;
    deps.persist(row.session_id, finalTitle);

    if (finalTitle !== raw) {
      try {
        await deps.broadcast(row.session_id);
      } catch (error) {
        console.warn(`[AI titles] Broadcast failed for session ${row.session_id}: ${errorMessage(error)}`);
      }
      rewritten += 1;
    }
  }

  return { rewritten, attempted, failed: false };
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;
let consecutiveFailures = 0;
let cooldownTicks = 0;

/**
 * One scheduler tick: honors the in-flight guard and failure cooldown, pulls a
 * batch, and delegates the per-row work to processTitleBatch.
 */
async function runTick(config: TitlerConfig): Promise<void> {
  if (tickInFlight) {
    return;
  }
  if (cooldownTicks > 0) {
    cooldownTicks -= 1;
    return;
  }
  tickInFlight = true;

  try {
    const rows = sessionsDb.getSessionsNeedingAiTitle(config.minLength, config.batchSize);
    if (rows.length === 0) {
      return;
    }

    const result = await processTitleBatch(rows, {
      generate: (raw) => generateShortTitle(raw, { ollamaUrl: config.ollamaUrl, model: config.model }),
      persist: (sessionId, title) => sessionsDb.updateSessionCustomName(sessionId, title, 'ai'),
      broadcast: (sessionId) => broadcastSessionUpserted(sessionId),
    });

    if (result.failed) {
      if (consecutiveFailures === 0) {
        console.warn('[AI titles] Ollama request failed; pausing and retrying with backoff.');
      }
      consecutiveFailures += 1;
      cooldownTicks = Math.min(consecutiveFailures, MAX_COOLDOWN_TICKS);
      return;
    }

    if (result.attempted > 0 && consecutiveFailures > 0) {
      console.log('[AI titles] Ollama reachable again, resuming.');
      consecutiveFailures = 0;
    }

    if (result.rewritten > 0) {
      console.log(`[AI titles] Rewrote ${result.rewritten} session title(s).`);
    }
  } catch (error) {
    console.error(`[AI titles] Tick failed: ${errorMessage(error)}`);
  } finally {
    tickInFlight = false;
  }
}

/**
 * Starts the periodic titler. No-op (with one info log) when disabled or when
 * already running. The interval is unref'd so it never blocks shutdown.
 */
export function startAiSessionTitler(): void {
  const config = readConfig();

  if (!config.enabled) {
    console.log('[AI titles] Disabled (set CLOUDCLI_AI_TITLES_ENABLED=true to enable).');
    return;
  }
  if (timer) {
    return;
  }

  consecutiveFailures = 0;
  cooldownTicks = 0;
  console.log(
    `[AI titles] Enabled — model=${config.model}, url=${config.ollamaUrl}, ` +
      `every ${config.intervalMs}ms, batch ${config.batchSize}, min length ${config.minLength}.`
  );

  timer = setInterval(() => {
    void runTick(config);
  }, config.intervalMs);
  timer.unref?.();
}

/**
 * Stops the periodic titler. Safe to call when it was never started.
 */
export function stopAiSessionTitler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
