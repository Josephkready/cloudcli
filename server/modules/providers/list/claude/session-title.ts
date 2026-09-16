import { iterateJsonlLines } from '@/shared/jsonl.js';

// Pure session-title selection logic, kept DB-free so it unit-tests without the
// database/native-module import chain. The Claude session synchronizer reads a
// transcript file and defers both the scan and the choice to this module.

export type SessionTitleCandidates = {
  /** Model-generated title Claude Code writes as an `ai-title` event. */
  aiTitle?: string;
  /** Title from a user rename in Claude Code (`custom-title` event). */
  customTitle?: string;
  /** The most recent prompt text (`last-prompt` event). */
  lastPrompt?: string;
  /**
   * Text of the oldest `user` row in the transcript — the opening prompt, read
   * from the conversation itself rather than from a title event.
   *
   * The weakest candidate, and the only one that survives a session whose
   * prompts were all slash commands: Claude Code writes its `last-prompt`
   * events for those with a `leafUuid` and **no `lastPrompt` field at all**, so
   * every other prompt-shaped candidate is absent and the session sat at
   * "Untitled Claude Session" forever (cloudcli#503/#505). The `leafUuid` is no
   * help — it points at the tail of the conversation branch (an `attachment` or
   * an `assistant` row), not at the prompt.
   */
  firstUserPrompt?: string;
};

/**
 * Renders Claude Code's slash-command envelope as the line the user typed.
 *
 * A `/goal do the thing` prompt is stored as
 * `<command-name>/goal</command-name><command-message>…</command-message><command-args>do the thing</command-args>`,
 * which is unreadable as a sidebar label and is exactly the shape that reaches
 * this fallback. Anything without a `<command-name>` is returned unchanged.
 */
export function readableUserPrompt(text: string): string {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) {
    // Not an envelope — but still strip any stray tags so a partial match can
    // never leak markup into the sidebar.
    return text.replace(/<\/?[a-z-]+>/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
  const command = name.startsWith('/') ? name : `/${name}`;
  return `${command}${args ? ` ${args}` : ''}`.replace(/\s+/g, ' ').trim();
}

/**
 * Scan transcript lines newest-first and collect the most-recent value of each
 * title-bearing event type (`ai-title` / `custom-title` / `last-prompt`) for the
 * given session. Lines that aren't JSON, don't match `sessionId`, or aren't a
 * recognized non-empty title event are skipped. Stored values are trimmed. Stops
 * early once all three types have been found.
 *
 * Collecting per-type (rather than returning whichever type appeared last) means
 * an older `ai-title` isn't shadowed by a more recent `last-prompt`.
 */
export function extractTitleCandidatesFromLines(
  lines: readonly string[],
  sessionId: string,
): SessionTitleCandidates {
  const candidates: SessionTitleCandidates = {};

  for (const data of iterateJsonlLines<Record<string, unknown>>(lines, { fromEnd: true })) {
    if (data.sessionId !== sessionId) {
      continue;
    }

    if (
      data.type === 'ai-title'
      && candidates.aiTitle === undefined
      && typeof data.aiTitle === 'string'
      && data.aiTitle.trim()
    ) {
      candidates.aiTitle = data.aiTitle.trim();
    } else if (
      data.type === 'custom-title'
      && candidates.customTitle === undefined
      && typeof data.customTitle === 'string'
      && data.customTitle.trim()
    ) {
      candidates.customTitle = data.customTitle.trim();
    } else if (
      data.type === 'last-prompt'
      && candidates.lastPrompt === undefined
      && typeof data.lastPrompt === 'string'
      && data.lastPrompt.trim()
    ) {
      candidates.lastPrompt = data.lastPrompt.trim();
    }

    if (
      candidates.aiTitle !== undefined
      && candidates.customTitle !== undefined
      && candidates.lastPrompt !== undefined
    ) {
      break;
    }
  }

  // Only when every title event came up empty, because this one is a forward
  // scan: the opening prompt is the OLDEST matching row, the opposite end from
  // everything above. Skipped entirely in the common case so a long transcript
  // is still read from the end alone.
  if (
    candidates.aiTitle === undefined
    && candidates.customTitle === undefined
    && candidates.lastPrompt === undefined
  ) {
    // Assigned only when there is one, so "no candidates at all" stays an
    // empty object rather than one carrying an explicit `undefined`.
    const firstUserPrompt = findFirstUserPrompt(lines, sessionId);
    if (firstUserPrompt) {
      candidates.firstUserPrompt = firstUserPrompt;
    }
  }

  return candidates;
}

/**
 * Text of the oldest `user` row for `sessionId`, rendered as a readable line.
 *
 * Tool results and other synthetic user-role rows carry structured content
 * rather than typed text; those yield nothing here and are passed over, so the
 * result is the first thing a person actually typed.
 */
function findFirstUserPrompt(lines: readonly string[], sessionId: string): string | undefined {
  for (const raw of lines) {
    const line = raw?.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const data = parsed as Record<string, unknown>;
    if (data.sessionId !== sessionId || data.type !== 'user') continue;

    const message = data.message as Record<string, unknown> | undefined;
    const content = message?.content;

    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((part): part is { type?: unknown; text?: unknown } =>
              typeof part === 'object' && part !== null)
            .filter((part) => part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text as string)
            .join(' ')
        : '';

    const readable = readableUserPrompt(text.trim());
    if (readable) return readable;
  }

  return undefined;
}

/**
 * Choose a session's display name from the title-bearing transcript events plus the
 * first-prompt `display` (from history.jsonl). Precedence, strongest first:
 *   1. a user rename in Claude Code (`custom-title`) — explicit intent
 *   2. the model-written `ai-title` — the readable summary we want by default
 *   3. the first prompt typed (`firstPromptDisplay`) — the historical fallback
 *   4. the most recent prompt (`last-prompt`)
 *   5. the opening prompt read from the transcript (`firstUserPrompt`) — weakest,
 *      and the only candidate a slash-command-only session has at all
 * Candidate values are already trimmed-non-empty by `extractTitleCandidatesFromLines`.
 * Returns undefined when nothing is available (the caller normalizes to a placeholder).
 */
export function pickDiscoveredSessionName(
  candidates: SessionTitleCandidates,
  firstPromptDisplay: string | undefined,
): string | undefined {
  // Treat an empty/whitespace display as absent so it doesn't shadow last-prompt.
  const firstPrompt = firstPromptDisplay?.trim() ? firstPromptDisplay : undefined;
  return candidates.customTitle
    ?? candidates.aiTitle
    ?? firstPrompt
    ?? candidates.lastPrompt
    ?? candidates.firstUserPrompt;
}
