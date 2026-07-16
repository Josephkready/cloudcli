/**
 * Turns a raw "first-prompt" session title into a short sidebar label using a
 * local Ollama model. Pure and side-effect free (no DB, no scheduling) so it can
 * be unit-tested with a stubbed `fetch`; the scheduling worker lives in
 * ai-session-titler.service.ts.
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

export interface TitleGeneratorOptions {
  ollamaUrl: string;
  model: string;
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
 * Requests a short title for one raw title.
 *
 * Returns the cleaned title, or `null` when the model produced nothing usable
 * (empty or too long) — the caller should skip that row. Network/HTTP failures
 * throw so the worker can back off; an unusable-but-successful response does not.
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
    const response = await fetchImpl(`${options.ollamaUrl.replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        system: SYSTEM_PROMPT,
        prompt: source,
        stream: false,
        keep_alive: '5m',
        options: { temperature: 0.2, top_p: 0.9, num_predict: 24 },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama responded ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { response?: unknown };
    const title = cleanTitle(typeof data.response === 'string' ? data.response : '');
    if (!title || title.length > MAX_TITLE_LENGTH) {
      return null;
    }
    return title;
  } finally {
    clearTimeout(timer);
  }
}
