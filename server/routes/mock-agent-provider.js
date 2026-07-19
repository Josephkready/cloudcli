/**
 * Deterministic in-process agent provider, used only for tests.
 *
 * Gated behind `AGENT_MOCK_PROVIDER=true` in the `POST /api/agent` handler (see
 * agent.js), this stands in for a real CLI/SDK provider so the route can be
 * integration-tested end-to-end — the non-streaming JSON assembly AND the
 * streaming SSE path — without a provider binary, network, or real auth. It
 * drives the exact writer contract every real provider uses: `setSessionId()`
 * followed by a series of normalized `kind`-frames.
 *
 * Transport parity: like the Codex adapter's `sendMessage()`, frames are handed
 * to the writer as objects when the writer marks itself object-accepting
 * (`isSSEStreamWriter` / `isWebSocketWriter`) and as JSON strings otherwise
 * (e.g. the non-streaming `ResponseCollector`). This deliberately exercises BOTH
 * the object path and the JSON-string path that silently regressed in #96.
 */

/** Assistant prose, split across frames the way real adapters chunk a reply. */
const ASSISTANT_TEXT_PARTS = ['Hello from ', 'the mock provider.'];

/** The full assistant reply the collector should reconstruct. */
export const MOCK_ASSISTANT_TEXT = ASSISTANT_TEXT_PARTS.join('');

/** How many `kind:'text'` assistant frames a run emits. */
export const MOCK_ASSISTANT_FRAME_COUNT = ASSISTANT_TEXT_PARTS.length;

/** Cumulative token snapshot the run reports via a `token_budget` status frame. */
export const MOCK_TOKEN_BUDGET = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Run the mock provider against a writer.
 *
 * @param {string} message - The user's task message (echoed only via logs).
 * @param {{ sessionId?: string|null }} [options] - Run options; `sessionId`
 *        seeds the emitted session id when provided.
 * @param {{ send: Function, setSessionId: Function, isSSEStreamWriter?: boolean,
 *        isWebSocketWriter?: boolean }} writer - The SSE / collector writer.
 */
export async function runMockAgentProvider(message, options = {}, writer) {
  const sessionId = options.sessionId || 'mock-session';

  // Object for object-accepting transports (SSE/WebSocket), JSON string
  // otherwise — mirrors the real Codex transport-detection behavior.
  const emit = (frame) => {
    if (writer.isSSEStreamWriter || writer.isWebSocketWriter) {
      writer.send(frame);
    } else {
      writer.send(JSON.stringify(frame));
    }
  };

  writer.setSessionId(sessionId);

  // A non-assistant frame that must NOT appear in getAssistantMessages().
  emit({ kind: 'status', text: 'thinking', sessionId });

  for (const content of ASSISTANT_TEXT_PARTS) {
    emit({ kind: 'text', role: 'assistant', content, sessionId });
  }

  // Cumulative token-budget snapshot the collector reads for the token summary.
  emit({ kind: 'status', text: 'token_budget', tokenBudget: { ...MOCK_TOKEN_BUDGET }, sessionId });

  return { sessionId };
}
