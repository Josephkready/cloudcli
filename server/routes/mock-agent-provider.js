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
 * Frames are always handed to the writer as objects — the same as every real
 * provider today (see `sendMessage()` in codex-send-message.js, which since #134
 * calls `ws.send(data)` unconditionally rather than JSON-encoding for
 * "unflagged" writers, the allow-list that was a root cause of #96). The
 * `ResponseCollector`'s tolerance of stringified frames is a separate
 * backward-compat shim, covered directly in agent-response-collector.test.js.
 */
import { randomUUID } from 'node:crypto';

import { createCompleteMessage, createNormalizedMessage } from '../shared/utils.js';

import {
  MOCK_CODE_BLOCK_SENTINEL,
  MOCK_DIFF_FILE,
  MOCK_DIFF_NEW,
  MOCK_DIFF_OLD,
  MOCK_HOLD_RUN_MS,
  MOCK_HOLD_RUN_SENTINEL,
  MOCK_LONG_CODE_LINE,
  MOCK_LONG_INLINE_TOKEN,
  MOCK_WIDE_BASH_COMMAND,
  MOCK_WIDE_BASH_OUTPUT,
} from './mock-agent-fixtures.js';

/** Assistant prose, split across frames the way real adapters chunk a reply. */
const ASSISTANT_TEXT_PARTS = ['Hello from ', 'the mock provider.'];

/**
 * Reply used when the task message carries `MOCK_CODE_BLOCK_SENTINEL`.
 *
 * A code block is the one thing a layout regression can be measured on, and
 * measuring it needs a real engine, so `e2e/code-block-scroll.spec.ts` drives
 * this path to check that a long line scrolls rather than wraps (it cannot be
 * checked in jsdom, which has no layout). The literals live in
 * `mock-agent-fixtures.js` so the spec can read them without importing this
 * module's server-side dependencies.
 */
const CODE_SURFACE_TEXT_PARTS = [
  `Inline \`${MOCK_LONG_INLINE_TOKEN}\` inside a sentence still wraps.\n\n`,
  '```ts\n' + MOCK_LONG_CODE_LINE + '\nconst short = 1;\n```\n',
];

/**
 * Tool frames emitted alongside the code-surface reply.
 *
 * These exist so the wide-output Bash block and the diff viewer — the other two
 * surfaces the force-wrap rule used to hit — can be measured in a real engine
 * and captured in the before/after screenshots, rather than being argued about
 * from their class lists.
 */
const CODE_SURFACE_TOOL_FRAMES = [
  {
    kind: 'tool_use',
    toolName: 'Bash',
    toolId: 'mock-tool-bash',
    toolInput: { command: MOCK_WIDE_BASH_COMMAND, description: 'search the tool renderers' },
  },
  {
    // A standalone tool_result carries its payload in `content` (the frontend's
    // toolResultMap reads `msg.content`), not in a nested `toolResult`.
    kind: 'tool_result',
    toolId: 'mock-tool-bash',
    content: MOCK_WIDE_BASH_OUTPUT,
    isError: false,
  },
  {
    kind: 'tool_use',
    toolName: 'Edit',
    toolId: 'mock-tool-edit',
    toolInput: {
      file_path: MOCK_DIFF_FILE,
      old_string: MOCK_DIFF_OLD,
      new_string: MOCK_DIFF_NEW,
    },
  },
];

/** The full assistant reply the collector should reconstruct. */
export const MOCK_ASSISTANT_TEXT = ASSISTANT_TEXT_PARTS.join('');

/** How many `kind:'text'` assistant frames a run emits. */
export const MOCK_ASSISTANT_FRAME_COUNT = ASSISTANT_TEXT_PARTS.length;

/**
 * Prefix that turns a prompt into "reply with the rest of this message".
 *
 * The mock's fixed reply is the right default — a deterministic transcript is
 * what most e2e specs want — but some assertions are about how a *particular*
 * assistant reply renders, and there is otherwise no way for a browser test to
 * put chosen markdown into an assistant bubble. Rendering ```` ```mermaid ````
 * fences is the case that needed it: the diagram has to come from the assistant
 * side, because user messages are deliberately not rendered as markdown.
 *
 * Opt-in by prefix, so every existing spec keeps the fixed reply untouched.
 */
export const MOCK_ECHO_PREFIX = 'echo:';

/**
 * Prefix that makes the run *stream*: the reply arrives as
 * `MOCK_STREAM_CHUNKS` `stream_delta` frames spaced `MOCK_STREAM_CHUNK_DELAY_MS`
 * apart, then `stream_end`, then one `text` frame holding the whole reply — the
 * frame order real providers produce.
 *
 * The fixed reply finishes in a single tick, so it can never exercise anything
 * that happens *while* a run is live. This one keeps the run open for about a
 * second with its first chunk already sent, which is what a `chat.subscribe`
 * replay needs to race it (#541: a new session's subscribes re-sent that first
 * chunk and it rendered four times). The rest of the prompt is ignored.
 */
export const MOCK_STREAM_PREFIX = 'stream:';
export const MOCK_STREAM_CHUNKS = ['one ', 'two ', 'three ', 'four ', 'five ', 'six '];
export const MOCK_STREAM_CHUNK_DELAY_MS = 200;

/**
 * Prompt prefix that holds the reply back: `hold:<ms>:<rest>` waits `<ms>` after
 * the `thinking` frame, then answers `<rest>` exactly as if it had been sent
 * alone (so it composes with `echo:`).
 *
 * The fixed reply lands within a few milliseconds of the send, which leaves a
 * browser test no window in which the run is live but its reply has not arrived.
 * Auto-follow bugs live in that window (cloudcli#540: the pane is nudged while a
 * run streams, and the reply that lands afterwards must still be followed), so a
 * spec needs a way to open it. Capped so a typo cannot wedge a worker's run.
 *
 * The parametric sibling of `MOCK_HOLD_RUN_SENTINEL`, whose fixed 15s hold is
 * sized for inspecting the running-turn UI, not for a spec that only needs the
 * reply to land a couple of seconds late.
 */
export const MOCK_HOLD_PREFIX = 'hold:';
const MOCK_HOLD_MAX_MS = 10_000;

/**
 * Splits a `hold:<ms>:<rest>` prompt into its delay and the prompt to answer.
 * Anything that does not match the shape exactly is answered as-is, undelayed.
 */
export function parseMockHold(message) {
  const text = typeof message === 'string' ? message : '';
  const match = /^hold:(\d+):/.exec(text);
  if (!match) return { delayMs: 0, message };
  return {
    delayMs: Math.min(Number(match[1]), MOCK_HOLD_MAX_MS),
    message: text.slice(match[0].length),
  };
}

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
 * Shared by two seams:
 *  - `POST /api/agent` when `AGENT_MOCK_PROVIDER=true` (writer = SSE / ResponseCollector).
 *  - the chat WebSocket gateway's `spawnFns`, when `AGENT_MOCK_PROVIDER=true`
 *    re-points the real provider runtimes at this mock (writer = ChatSessionWriter).
 *    This is the seam the Playwright e2e suite drives so a full browser chat turn
 *    (send -> streamed frames -> terminal `complete`) runs with no real CLI/SDK.
 *
 * @param {string} message - The user's task message. Logged, and inspected for three
 *        independent test hooks: `MOCK_CODE_BLOCK_SENTINEL` anywhere in it swaps the
 *        prose reply for one made of code surfaces, a leading `MOCK_ECHO_PREFIX`
 *        makes the remainder the assistant's reply instead of the fixed
 *        `ASSISTANT_TEXT_PARTS`, and a leading `MOCK_STREAM_PREFIX` streams a fixed
 *        reply chunk by chunk. The sentinel wins if a spec somehow asks for more than one.
 * @param {{ sessionId?: string|null, provider?: string }} [options] - Run options;
 *        `sessionId` seeds the emitted session id when provided (a fresh unique id
 *        is minted otherwise so concurrent app sessions never share a provider id),
 *        and `provider` labels the terminal `complete` frame ('mock' by default).
 * @param {{ send: Function, setSessionId: Function }} writer - The SSE writer, the
 *        non-streaming ResponseCollector, or the chat gateway's ChatSessionWriter.
 */
export async function runMockAgentProvider(message, options = {}, writer) {
  const sessionId = options.sessionId || `mock-session-${randomUUID()}`;
  // Provider label stamped onto the emitted frames. The chat WebSocket seam
  // passes the real 'claude'/'codex' the session uses; the REST /api/agent seam
  // leaves it as the test-only 'mock' sentinel (intentionally outside the
  // LLMProvider union — these frames are only produced when AGENT_MOCK_PROVIDER
  // is set, and no consumer branches on it).
  const provider = options.provider || 'mock';

  writer.setSessionId(sessionId);

  // Frames mirror the real providers: each is a normalized envelope built by
  // createNormalizedMessage(), so it carries id/sessionId/timestamp/provider
  // exactly as claude-sdk.js / openai-codex.js emit — the frontend renders them
  // (and their timestamps) identically to a real run.
  //
  // A non-assistant frame that must NOT appear in getAssistantMessages().
  writer.send(createNormalizedMessage({ kind: 'status', text: 'thinking', sessionId, provider }));

  // Holds the run in progress, so a spec can inspect the running-turn UI
  // (activity indicator, Stop) before the reply lands.
  if (String(message || '').includes(MOCK_HOLD_RUN_SENTINEL)) {
    await new Promise((resolve) => setTimeout(resolve, MOCK_HOLD_RUN_MS));
  }

  const hold = parseMockHold(message);
  if (hold.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, hold.delayMs));
  }
  message = hold.message;

  // Three independent hooks, checked in precedence order. The sentinel swaps in the
  // code-surface fixture; `echo:` replies with the rest of the prompt as ONE frame,
  // because a spec that chooses the assistant's markdown wants it whole, not chunked;
  // `stream:` (handled below) streams a fixed reply over about a second.
  const wantsCodeSurfaces = String(message || '').includes(MOCK_CODE_BLOCK_SENTINEL);
  const textParts = wantsCodeSurfaces
    ? CODE_SURFACE_TEXT_PARTS
    : typeof message === 'string' && message.startsWith(MOCK_ECHO_PREFIX)
      ? [message.slice(MOCK_ECHO_PREFIX.length)]
      : ASSISTANT_TEXT_PARTS;

  if (!wantsCodeSurfaces && typeof message === 'string' && message.startsWith(MOCK_STREAM_PREFIX)) {
    for (const content of MOCK_STREAM_CHUNKS) {
      writer.send(createNormalizedMessage({ kind: 'stream_delta', content, sessionId, provider }));
      await new Promise((resolve) => setTimeout(resolve, MOCK_STREAM_CHUNK_DELAY_MS));
    }
    writer.send(createNormalizedMessage({ kind: 'stream_end', sessionId, provider }));
    writer.send(createNormalizedMessage({
      kind: 'text',
      role: 'assistant',
      content: MOCK_STREAM_CHUNKS.join(''),
      sessionId,
      provider,
    }));
  } else {
    for (const content of textParts) {
      writer.send(createNormalizedMessage({ kind: 'text', role: 'assistant', content, sessionId, provider }));
    }
  }

  if (wantsCodeSurfaces) {
    for (const frame of CODE_SURFACE_TOOL_FRAMES) {
      writer.send(createNormalizedMessage({ ...frame, sessionId, provider }));
    }
  }

  // Cumulative token-budget snapshot the collector reads for the token summary.
  writer.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: { ...MOCK_TOKEN_BUDGET }, sessionId, provider }));

  // Terminal lifecycle frame. Every real provider emits its own `complete`, and
  // the chat gateway treats `complete` as the only terminal signal (its finally
  // safety-net drops the duplicate). Emitting a successful one here lets a
  // browser e2e observe the turn transition from streaming to done. Harmless on
  // the REST path: the ResponseCollector filters to assistant text, and the SSE
  // stream is still terminated by the trailing `{ type: 'done' }` sentinel.
  writer.send(createCompleteMessage({ provider, sessionId, exitCode: 0 }));

  return { sessionId };
}
