/**
 * Turns a raw "first-prompt" session title into a short sidebar label using a
 * hosted OpenAI-compatible chat model — OpenRouter by default, with routing
 * pinned to zero-data-retention endpoints. Pure and side-effect free (no DB, no
 * scheduling) so it can be unit-tested with a stubbed `fetch`; the scheduling
 * worker lives in ai-session-titler.service.ts.
 */

const SYSTEM_PROMPT =
  "You write ultra-short titles for coding-assistant chat sessions, like the " +
  "labels in ChatGPT's sidebar. Given the opening message (possibly truncated " +
  "mid-word), output ONLY a 2-5 word Title Case label naming the task or topic. " +
  'No quotes, no trailing punctuation, no preamble, no explanation.';

// Longer output means the model failed to summarize (it echoed/expanded the
// prompt); treat that as unusable rather than storing a fresh wall of text.
const MAX_TITLE_LENGTH = 80;
const DEFAULT_TIMEOUT_MS = 20_000;

// A title is ~10 tokens, but on a reasoning model (the default `openai/gpt-5-nano`
// is one) this budget covers thinking tokens too, and a reply that runs out of
// budget mid-title is discarded below. Sized for headroom rather than thrift: the
// worst case is a fraction of a cent, a truncated title costs a row.
const MAX_OUTPUT_TOKENS = 256;

// How much of an error response body to keep in the thrown message. OpenRouter
// explains routing failures there — notably the 404 returned when no endpoint
// satisfies the provider block — so it is worth surfacing.
const ERROR_BODY_CHARS = 200;

export interface TitleGeneratorOptions {
  /** OpenAI-compatible API root, e.g. https://openrouter.ai/api/v1. */
  baseUrl: string;
  model: string;
  apiKey: string;
  /**
   * Restrict routing to zero-data-retention endpoints (OpenRouter-specific).
   * Turn off for OpenAI-compatible endpoints that reject an unknown `provider` field.
   */
  zdr?: boolean;
  /** OpenRouter reasoning effort; empty/undefined omits the parameter entirely. */
  reasoningEffort?: string;
  /**
   * Which output-cap parameter this model's endpoints accept —
   * `max_completion_tokens` (OpenAI-family) or `max_tokens` (most others).
   * Under `require_parameters: true` the wrong one filters every endpoint out.
   */
  maxTokensParam?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Normalizes raw model output into a clean title: first non-empty line, minus
 * any "Title:" preamble, surrounding quotes/asterisks, and trailing sentence
 * punctuation, with internal whitespace collapsed.
 */
export function cleanTitle(raw: string): string {
  if (!raw) {
    return '';
  }

  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';

  // Strip wrapping quotes/asterisks BEFORE the "Title:" preamble, then again
  // after — a model that ignores the instructions can emit e.g.
  // `**Title:** "Fix Login Bug"`, where the leading `**` would otherwise hide
  // the preamble from the prefix strip and leak `Title:**` into the label.
  return firstLine
    .replace(/^["'“”‘’`*\s]+/, '')
    .replace(/^(?:title|label)\s*[:\-]\s*/i, '')
    .replace(/^["'“”‘’`*\s]+/, '')
    .replace(/["'“”‘’`*\s]+$/, '')
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Builds the chat-completions request body.
 *
 * Deliberately sends no `temperature`/`top_p`: the ZDR block needs
 * `require_parameters: true` (otherwise routing can silently land on an endpoint
 * that drops a parameter it does not support), and under that flag every
 * unsupported parameter shrinks the endpoint pool. The default model's endpoints
 * do not advertise sampling parameters at all, so a stray `temperature` would
 * filter the pool to empty and 404 every request. The output cap is named by the
 * caller for the same reason — see `maxTokensParam`.
 */
export function buildTitleRequestBody(
  source: string,
  options: Pick<TitleGeneratorOptions, 'model' | 'zdr' | 'reasoningEffort' | 'maxTokensParam'>
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: source },
    ],
    [options.maxTokensParam || 'max_completion_tokens']: MAX_OUTPUT_TOKENS,
  };

  if (options.reasoningEffort) {
    body.reasoning = { effort: options.reasoningEffort };
  }
  if (options.zdr) {
    body.provider = { zdr: true, require_parameters: true };
  }

  return body;
}

interface ChatCompletionResponse {
  error?: { message?: unknown };
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown };
  }>;
}

/**
 * Bounds untrusted remote text for logging. The newline collapse is the
 * load-bearing half: this ends up inside a thrown Error that the worker logs on
 * one `[AI titles]` line, so a response body containing newlines could otherwise
 * forge extra log entries with that prefix.
 */
function loggableRemoteText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_CHARS);
}

/** Trims a remote error body down to a single loggable line. */
function errorSnippet(body: string): string {
  const collapsed = loggableRemoteText(body);
  return collapsed ? `: ${collapsed}` : '';
}

/**
 * Requests a short title for one raw title.
 *
 * Returns the cleaned title, or `null` when the model produced nothing usable
 * (empty, truncated, or too long) — the caller should skip that row.
 * Network/HTTP failures throw so the worker can back off; an
 * unusable-but-successful response does not.
 */
export async function generateShortTitle(
  rawTitle: string,
  options: TitleGeneratorOptions
): Promise<string | null> {
  const source = rawTitle.replace(/\s+/g, ' ').trim();
  if (!source) {
    return null;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(buildTitleRequestBody(source, options)),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Title API responded ${response.status} ${response.statusText}${errorSnippet(body)}`
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;

    // OpenRouter reports some upstream failures as an `error` object inside a
    // 200, so a status check alone would read that as an empty completion and
    // burn the row instead of backing off.
    if (data.error) {
      const message =
        typeof data.error.message === 'string' ? data.error.message : JSON.stringify(data.error);
      throw new Error(`Title API returned an error: ${loggableRemoteText(message)}`);
    }

    const choice = data.choices?.[0];
    // `length` means the reply hit MAX_OUTPUT_TOKENS — either a truncated title
    // or a model that spent the whole budget on reasoning. Neither is storable.
    if (choice?.finish_reason === 'length') {
      return null;
    }

    const content = choice?.message?.content;
    const title = cleanTitle(typeof content === 'string' ? content : '');
    if (!title || title.length > MAX_TITLE_LENGTH) {
      return null;
    }
    return title;
  } finally {
    clearTimeout(timer);
  }
}
