/**
 * Coerce a buffered frame to its object form.
 *
 * Most provider transports hand this collector normalized objects, but the Codex
 * runtime routes frames through a `sendMessage()` helper (openai-codex.js) that
 * JSON-encodes them for any transport it doesn't recognize as an object-accepting
 * writer (it keys off `isSSEStreamWriter`/`isWebSocketWriter`, which this
 * collector deliberately does not set). So Codex frames arrive as strings — parse
 * them back so the read methods see a single shape. Non-JSON strings yield null
 * and are ignored by callers.
 */
function toMessageObject(msg) {
  if (typeof msg === 'string') {
    try {
      return JSON.parse(msg);
    } catch {
      return null;
    }
  }
  return msg;
}

/**
 * Non-streaming response collector for `POST /api/agent`.
 *
 * Stands in for the SSE writer when a caller requests `stream:false`: it buffers
 * every event a provider run emits, then distills the assistant text and token
 * usage for a single JSON reply. Kept in its own module (with no provider/DB
 * imports) so it can be unit-tested without loading the whole agent route.
 */
export class ResponseCollector {
  constructor(userId = null) {
    this.messages = [];
    this.sessionId = null;
    this.userId = userId;
  }

  send(data) {
    // Store ALL messages for now - we'll filter when returning
    this.messages.push(data);

    // Extract sessionId if present
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed.sessionId) {
          this.sessionId = parsed.sessionId;
        }
      } catch (e) {
        // Not JSON, ignore
      }
    } else if (data && data.sessionId) {
      this.sessionId = data.sessionId;
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
   * Get filtered assistant messages only.
   *
   * Every provider now streams normalized `kind`-based envelopes
   * (`createNormalizedMessage`); assistant prose arrives as `kind:'text'` with
   * `role:'assistant'`. The legacy `{ type:'claude-response', data:{...} }` wire
   * shape this used to match is no longer produced by any provider, so the old
   * filter silently returned `[]`. See #96.
   */
  getAssistantMessages() {
    const assistantMessages = [];

    for (const raw of this.messages) {
      const msg = toMessageObject(raw);
      if (
        msg &&
        typeof msg === 'object' &&
        msg.kind === 'text' &&
        msg.role === 'assistant'
      ) {
        assistantMessages.push(msg);
      }
    }

    return assistantMessages;
  }

  /**
   * Calculate total tokens for the run.
   *
   * Usage is reported via `kind:'status'` frames tagged `token_budget`, each
   * carrying a `tokenBudget` snapshot (see `extractTokenBudget` in claude-sdk.js
   * and the Codex/OpenCode equivalents). Every provider's snapshot is
   * **cumulative** — Claude reports the growing per-turn context, Codex/OpenCode
   * report a running session total — so the last frame is the authoritative
   * total. Summing across frames would multiply-count. `tokenBudget.inputTokens`
   * already includes cache tokens, matching the previous output shape. See #96.
   */
  getTotalTokens() {
    let latest = null;

    for (const raw of this.messages) {
      const msg = toMessageObject(raw);
      if (
        msg &&
        typeof msg === 'object' &&
        msg.kind === 'status' &&
        msg.text === 'token_budget' &&
        msg.tokenBudget &&
        typeof msg.tokenBudget === 'object'
      ) {
        latest = msg.tokenBudget;
      }
    }

    const inputTokens = Number(latest?.inputTokens) || 0;
    const outputTokens = Number(latest?.outputTokens) || 0;
    const cacheReadTokens = Number(latest?.cacheReadTokens) || 0;
    const cacheCreationTokens = Number(latest?.cacheCreationTokens) || 0;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens: inputTokens + outputTokens
    };
  }
}
