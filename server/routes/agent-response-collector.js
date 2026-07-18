/**
 * Non-streaming response collector for `POST /api/agent`.
 *
 * Providers stream `createNormalizedMessage()` envelopes (keyed by `kind`)
 * through this writer exactly as they do to a websocket. This collector buffers
 * them and, at the end of the run, distills the assistant text and token totals
 * for the JSON response.
 *
 * Kept in its own module (no provider/database imports) so it can be unit
 * tested in isolation — see agent-response-collector.test.js.
 */

/**
 * Coerces a possibly-numeric value to a finite number, defaulting to 0.
 */
function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class ResponseCollector {
  constructor(userId = null) {
    this.messages = [];
    this.sessionId = null;
    this.userId = userId;
  }

  send(data) {
    // Store ALL messages for now - we'll filter when returning
    this.messages.push(data);

    const parsed = ResponseCollector.#asObject(data);
    if (parsed && parsed.sessionId) {
      this.sessionId = parsed.sessionId;
    }
  }

  end() {
    // Do nothing - we'll collect all messages
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  getSessionId() {
    return this.sessionId;
  }

  getMessages() {
    return this.messages;
  }

  /**
   * Normalizes a buffered entry (a normalized-message object, or a JSON string
   * of one) into a plain object, or null if it isn't parseable/object-shaped.
   */
  static #asObject(msg) {
    if (typeof msg === 'string') {
      try {
        return JSON.parse(msg);
      } catch (e) {
        return null;
      }
    }
    return msg && typeof msg === 'object' ? msg : null;
  }

  /**
   * Get the assistant text turns from the run.
   *
   * Every provider now emits normalized `{ kind: 'text', role: 'assistant' }`
   * envelopes (see each provider's `normalizeMessage`); the legacy
   * `claude-response` wire shape this used to match is no longer produced.
   */
  getAssistantMessages() {
    const assistantMessages = [];

    for (const msg of this.messages) {
      const data = ResponseCollector.#asObject(msg);
      if (!data || data.kind !== 'text' || data.role !== 'assistant') {
        continue;
      }

      const content =
        typeof data.content === 'string' && data.content
          ? data.content
          : typeof data.text === 'string'
            ? data.text
            : '';
      if (!content) {
        continue;
      }

      assistantMessages.push({
        id: data.id,
        role: 'assistant',
        content,
        provider: data.provider,
        timestamp: data.timestamp,
      });
    }

    return assistantMessages;
  }

  /**
   * Total token usage for the run.
   *
   * Providers emit cumulative usage as `{ kind: 'status', text: 'token_budget',
   * tokenBudget: {...} }` frames (see `extractTokenBudget` in claude-sdk.js and
   * `extractCodexTokenBudget` in openai-codex.js). Each frame carries the
   * running total, so — mirroring the streaming UI, which *replaces* rather than
   * accumulates — we report the last frame's values, not a sum (summing would
   * double-count the intermediate turns already folded into the final total).
   */
  getTotalTokens() {
    let latest = null;

    for (const msg of this.messages) {
      const data = ResponseCollector.#asObject(msg);
      if (
        data &&
        data.kind === 'status' &&
        data.text === 'token_budget' &&
        data.tokenBudget &&
        typeof data.tokenBudget === 'object'
      ) {
        latest = data.tokenBudget;
      }
    }

    if (!latest) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
      };
    }

    // `inputTokens` from the budget already folds in cache tokens (see
    // extractTokenBudget), matching the legacy shape where input included cache.
    const inputTokens = toFiniteNumber(latest.inputTokens);
    const outputTokens = toFiniteNumber(latest.outputTokens);
    const cacheReadTokens = toFiniteNumber(latest.cacheReadTokens);
    const cacheCreationTokens = toFiniteNumber(latest.cacheCreationTokens);
    const totalTokens = toFiniteNumber(latest.used) || inputTokens + outputTokens;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens,
    };
  }
}
