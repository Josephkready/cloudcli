export type TokenBudget = Record<string, unknown>;

const readNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Total tokens a budget payload reports, across both shapes in play.
 *
 * The live `token_budget` websocket frame carries
 * `{inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens}`; the REST
 * `/token-usage` endpoint carries `{used, total, breakdown:{input, …}}`.
 * `TokenUsageSummary` already reconciles the two for display — this mirrors that
 * so the comparison below matches what the user actually sees.
 */
export function readTokenBudgetUsed(budget: TokenBudget | null | undefined): number {
  if (!budget) {
    return 0;
  }

  const breakdown =
    budget.breakdown && typeof budget.breakdown === 'object'
      ? (budget.breakdown as Record<string, unknown>)
      : null;

  const inputTokens = readNumber(budget.inputTokens ?? breakdown?.input);
  const outputTokens = readNumber(budget.outputTokens ?? breakdown?.output);

  return readNumber(budget.used) || inputTokens + outputTokens;
}

/**
 * Reconciles a server-sourced budget against whatever is already on screen (#240).
 *
 * A brand-new session is created *by* the run, so the frame order is:
 *
 *   status/token_budget   → live value stored ({inputTokens:100, outputTokens:20})
 *   session_upserted      → selectedSession.id changes
 *                         → GET …/token-usage → {"used":0,…} → clobbered
 *
 * The REST value lands last and always wins, and it reads 0 because the
 * transcript has not been indexed yet — the same JSONL indexing lag
 * `pruneRealtimeSupersededByServer` already documents. The first turn of every
 * new chat therefore under-reported as 0 until the user navigated away and back.
 *
 * A session's token usage only ever grows, so "keep whichever reports more" is a
 * real domain invariant rather than a tie-breaking hack: it needs no sequence
 * numbers, is insensitive to arrival order, and can never *lose* usage. The
 * incoming value wins ties so the richer server shape (which carries `total`,
 * needed by the Token Usage modal) replaces an equivalent live frame once
 * indexing has caught up.
 *
 * Callers must still scope this to one session — the existing session-change
 * reset to `null` is what provides that.
 */
export function reconcileTokenBudget(
  current: TokenBudget | null,
  incoming: TokenBudget | null,
): TokenBudget | null {
  if (!incoming) {
    return current;
  }

  if (!current) {
    return incoming;
  }

  return readTokenBudgetUsed(incoming) >= readTokenBudgetUsed(current) ? incoming : current;
}
