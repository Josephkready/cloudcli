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
};

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

  return candidates;
}

/**
 * Choose a session's display name from the title-bearing transcript events plus the
 * first-prompt `display` (from history.jsonl). Precedence, strongest first:
 *   1. a user rename in Claude Code (`custom-title`) — explicit intent
 *   2. the model-written `ai-title` — the readable summary we want by default
 *   3. the first prompt typed (`firstPromptDisplay`) — the historical fallback
 *   4. the most recent prompt (`last-prompt`) — weakest
 * Candidate values are already trimmed-non-empty by `extractTitleCandidatesFromLines`.
 * Returns undefined when nothing is available (the caller normalizes to a placeholder).
 */
export function pickDiscoveredSessionName(
  candidates: SessionTitleCandidates,
  firstPromptDisplay: string | undefined,
): string | undefined {
  // Treat an empty/whitespace display as absent so it doesn't shadow last-prompt.
  const firstPrompt = firstPromptDisplay?.trim() ? firstPromptDisplay : undefined;
  return candidates.customTitle ?? candidates.aiTitle ?? firstPrompt ?? candidates.lastPrompt;
}
