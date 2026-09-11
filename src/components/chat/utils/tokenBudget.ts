export type TokenBudget = Record<string, unknown>;

const readNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Current context-window occupancy a budget payload reports, across both
 * shapes in play.
 *
 * The live `token_budget` websocket frame carries
 * `{inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens}`; the REST
 * `/token-usage` endpoint carries `{used, total, breakdown:{input, cacheCreation,
 * cacheRead}}`. Despite the name, the WS frame's `inputTokens` already folds in
 * both cache counters (see `buildTokenBudget` in `server/claude-sdk.js`) — it
 * IS the context size, matching the REST shape's `used`/`breakdown` sum.
 *
 * Neither shape's "used"/`inputTokens` field ever includes `outputTokens`: the
 * reply the model just generated hasn't been resent as input yet, so it isn't
 * part of what currently occupies the context window. Folding it in was the
 * mechanism behind "200,000 tokens, then 50,000" — see `reconcileTokenBudget`
 * for the other half of that bug.
 */
export function readTokenBudgetUsed(budget: TokenBudget | null | undefined): number {
  if (!budget) {
    return 0;
  }

  // Live WS frame: identified by the cache counters that only this shape
  // carries at the top level.
  if ('cacheReadTokens' in budget || 'cacheCreationTokens' in budget) {
    return readNumber(budget.inputTokens);
  }

  // REST shape: `used` is already the full context-window occupancy; the
  // breakdown sum is a fallback for a payload that only carries one or the
  // other (e.g. a hand-built fixture in a test).
  const used = readNumber(budget.used);
  if (used > 0) {
    return used;
  }

  const breakdown =
    budget.breakdown && typeof budget.breakdown === 'object'
      ? (budget.breakdown as Record<string, unknown>)
      : null;
  if (!breakdown) {
    return used;
  }

  return readNumber(breakdown.input) + readNumber(breakdown.cacheCreation) + readNumber(breakdown.cacheRead);
}

/**
 * Cumulative output tokens a budget payload reports, when it carries one.
 *
 * Only the live WS frame currently reports this (the REST `/token-usage`
 * shape has no output figure — the transcript's `usage` blocks are indexed
 * for context size, not cost). Returns `null` rather than `0` so a caller can
 * tell "no data" apart from "genuinely zero" and omit the secondary display
 * instead of showing a misleading "0".
 */
export function readTokenBudgetOutput(budget: TokenBudget | null | undefined): number | null {
  if (!budget || !('outputTokens' in budget)) {
    return null;
  }
  return readNumber(budget.outputTokens);
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
 * The original fix picked whichever side reported *more*, on the premise that
 * usage only ever grows. It doesn't: a mid-session compaction rebuilds the
 * transcript into a short summary, and the next real reading is genuinely
 * smaller. Under the old rule that smaller-but-real reading could never
 * displace a higher earlier one, so the widget got stuck at its pre-compaction
 * high-water mark — the other half of "200,000, then wrong forever after".
 *
 * The actual invariant is narrower than "usage only grows": a `used: 0` with
 * nothing in its breakdown is specifically the *unindexed* shape
 * (`buildEmptyTokenUsage`) — a transcript with no assistant usage record at
 * all yet, not a real reading of an empty context. Only that exact shape must
 * be prevented from clobbering a value already on screen; any other incoming
 * reading — bigger or smaller — is real and replaces the display outright.
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

  if (readTokenBudgetUsed(incoming) === 0) {
    // No real reading yet (transcript not indexed) — never erase a value
    // the run already reported.
    return current;
  }

  return incoming;
}
