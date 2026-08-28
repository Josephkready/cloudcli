/**
 * Background worker that rewrites long "first-prompt" session titles into short
 * ones using a hosted chat model, then broadcasts a live sidebar update.
 *
 * Opt-in and default-off (needs an API key): a no-op unless
 * CLOUDCLI_AI_TITLES_ENABLED=true and a key is configured. Runs a single,
 * sequential drip so a full backfill stays gentle and never overlaps itself.
 * Eligibility (which rows are "raw" and long enough) is decided in SQL by
 * sessionsDb.getSessionsNeedingAiTitle.
 *
 * Titles are generated from a session's opening message, so this sends that text
 * to the configured endpoint. The default routing pins OpenRouter to
 * zero-data-retention providers (see CLOUDCLI_AI_TITLES_ZDR in .env.example).
 */

import { readFileSync } from 'node:fs';

import { readKeyFromContents } from '@/shared/api-key-file.js';
import { sessionsDb } from '@/modules/database/index.js';
import { generateShortTitle } from '@/modules/providers/services/ai-title-generator.service.js';
import { broadcastSessionUpserted } from '@/modules/providers/services/sessions-watcher.service.js';

export interface TitlerConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  zdr: boolean;
  reasoningEffort: string;
  maxTokensParam: string;
  intervalMs: number;
  batchSize: number;
  minLength: number;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openai/gpt-5-nano';
// The default model is a reasoning model; without this it spends ~128 thinking
// tokens on a 5-word title (measured 2026-08-16: 8.6x the cost, 2.5s vs 1.6s).
const DEFAULT_REASONING_EFFORT = 'minimal';
// The default model's ZDR endpoint advertises max_completion_tokens and NOT
// max_tokens, and under `require_parameters: true` the wrong name filters every
// endpoint out and 404s. Most non-OpenAI models want max_tokens instead.
const DEFAULT_MAX_TOKENS_PARAM = 'max_completion_tokens';

/** Key names accepted in an env file, most specific first. */
const API_KEY_FILE_NAMES = ['CLOUDCLI_AI_TITLES_API_KEY', 'OPENROUTER_API_KEY'];

/** The subset of a session row the batch processor needs. */
interface TitleCandidate {
  session_id: string;
  custom_name: string | null;
}

/**
 * Injectable collaborators for one batch, so the ordering/marking invariants can
 * be unit-tested without a real DB, title API, or WebSocket clients.
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
  /** A generation request threw — the backend is unhealthy; caller should back off. */
  failed: boolean;
  /** Why it failed, for the backoff log (HTTP status, routing error, ...). */
  failureReason?: string;
}

// A generation attempt that throws means the title backend is unhealthy; skip up
// to this many subsequent ticks (growing with consecutive failures) so a
// sustained outage is retried with real backoff rather than at the fixed cadence.
const MAX_COOLDOWN_TICKS = 12;

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Extracts an API key from the contents of a protected env file, taking the
 * first `CLOUDCLI_AI_TITLES_API_KEY=` line and falling back to
 * `OPENROUTER_API_KEY=`. Reading one named key (rather than sourcing the file as
 * an EnvironmentFile) lets a deployment reuse a credential file it shares with
 * other services without importing every unrelated secret in it.
 */
export function parseApiKeyFile(contents: string): string {
  return readKeyFromContents(contents, API_KEY_FILE_NAMES);
}

function readApiKey(): string {
  const direct = process.env.CLOUDCLI_AI_TITLES_API_KEY?.trim();
  if (direct) {
    return direct;
  }

  const file = process.env.CLOUDCLI_AI_TITLES_API_KEY_FILE?.trim();
  if (!file) {
    return '';
  }

  try {
    return parseApiKeyFile(readFileSync(file, 'utf8'));
  } catch (error) {
    console.warn(`[AI titles] Could not read ${file}: ${errorMessage(error)}`);
    return '';
  }
}

/** Exported for tests: the env-parsing here carries several deliberate subtleties. */
export function readConfig(): TitlerConfig {
  return {
    enabled: process.env.CLOUDCLI_AI_TITLES_ENABLED === 'true',
    baseUrl: process.env.CLOUDCLI_AI_TITLES_BASE_URL?.trim() || DEFAULT_BASE_URL,
    model: process.env.CLOUDCLI_AI_TITLES_MODEL?.trim() || DEFAULT_MODEL,
    apiKey: readApiKey(),
    zdr: process.env.CLOUDCLI_AI_TITLES_ZDR !== 'false',
    // Explicitly empty omits the parameter — required for models whose endpoints
    // do not support it, which would otherwise 404 under require_parameters.
    reasoningEffort:
      process.env.CLOUDCLI_AI_TITLES_REASONING_EFFORT?.trim() ?? DEFAULT_REASONING_EFFORT,
    maxTokensParam:
      process.env.CLOUDCLI_AI_TITLES_MAX_TOKENS_PARAM?.trim() || DEFAULT_MAX_TOKENS_PARAM,
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
    } catch (error) {
      return { rewritten, attempted, failed: true, failureReason: errorMessage(error) };
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
      generate: (raw) =>
        generateShortTitle(raw, {
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: config.apiKey,
          zdr: config.zdr,
          reasoningEffort: config.reasoningEffort,
          maxTokensParam: config.maxTokensParam,
        }),
      persist: (sessionId, title) => sessionsDb.updateSessionCustomName(sessionId, title, 'ai'),
      broadcast: (sessionId) => broadcastSessionUpserted(sessionId),
    });

    if (result.failed) {
      // The reason is logged only on the first failure of a streak (the retries
      // are silent), so it has to carry enough to diagnose a misconfiguration —
      // a 401 key problem and a 404 "no endpoints match" read very differently.
      if (consecutiveFailures === 0) {
        console.warn(
          `[AI titles] Title request failed; pausing and retrying with backoff. ${result.failureReason ?? ''}`.trim()
        );
      }
      consecutiveFailures += 1;
      cooldownTicks = Math.min(consecutiveFailures, MAX_COOLDOWN_TICKS);
      return;
    }

    if (result.attempted > 0 && consecutiveFailures > 0) {
      console.log('[AI titles] Title backend reachable again, resuming.');
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
 * Starts the periodic titler. No-op (with one info log) when disabled, when no
 * API key is configured, or when already running.
 * The interval is unref'd so it never blocks shutdown.
 */
export function startAiSessionTitler(): void {
  // Checked before readConfig() so a disabled feature does no work at all —
  // readConfig reads the key file, which would otherwise warn on every startup
  // about an unreadable path that nothing was going to use.
  if (process.env.CLOUDCLI_AI_TITLES_ENABLED !== 'true') {
    console.log('[AI titles] Disabled (set CLOUDCLI_AI_TITLES_ENABLED=true to enable).');
    return;
  }

  const config = readConfig();
  // Refusing to start beats hammering the endpoint with unauthenticated requests
  // that only fail after a full backoff cycle. A keyless local endpoint can pass
  // any non-empty placeholder.
  if (!config.apiKey) {
    console.warn(
      '[AI titles] Enabled but no API key — set CLOUDCLI_AI_TITLES_API_KEY or ' +
        'CLOUDCLI_AI_TITLES_API_KEY_FILE. Not starting.'
    );
    return;
  }
  if (timer) {
    return;
  }

  consecutiveFailures = 0;
  cooldownTicks = 0;
  console.log(
    `[AI titles] Enabled — model=${config.model}, url=${config.baseUrl}, ` +
      `zdr=${config.zdr ? 'on' : 'off'}, every ${config.intervalMs}ms, ` +
      `batch ${config.batchSize}, min length ${config.minLength}.`
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
