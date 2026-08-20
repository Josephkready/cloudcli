import { normalizeSessionName } from '@/shared/utils.js';

/**
 * The longest opening-line title worth storing.
 *
 * `normalizeSessionName` bounds at 120, which is right for a provider-supplied
 * name but far too long for a sidebar row — the list truncates with an ellipsis
 * well before that, so the extra characters only cost storage and make the AI
 * titler's input noisier. 80 keeps a full sentence in most cases.
 */
const MAX_OPENING_NAME_LENGTH = 80;

/** Sentinel names the synchronizers write when they have nothing better. */
const PLACEHOLDER_NAMES = new Set([
  'untitled claude session',
  'untitled codex session',
  'untitled session',
  'new session',
]);

/**
 * Does this session still need a name derived from its opening message?
 *
 * True only for a genuinely unnamed row. A blank `custom_name` is the common
 * case (app-created sessions start with none), and the synchronizer placeholders
 * count as blank because they carry no information either.
 */
export function needsOpeningName(customName: string | null | undefined): boolean {
  const normalized = (customName ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return true;
  }
  return PLACEHOLDER_NAMES.has(normalized.toLowerCase());
}

/**
 * Derive a session title from the first thing the user said.
 *
 * Returns `null` when the message yields nothing usable, so the caller can leave
 * the row untouched rather than storing an empty or meaningless name.
 *
 * Slash commands are rejected: a session called "/model" or "/cost" is no more
 * navigable than "New Session", and the *next* message is a better source. The
 * command's arguments are not a title either — `/model opus` describes the
 * command, not the conversation.
 */
export function deriveOpeningName(content: string | null | undefined): string | null {
  const collapsed = (content ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return null;
  }

  if (collapsed.startsWith('/')) {
    return null;
  }

  const normalized = normalizeSessionName(collapsed, '');
  if (!normalized) {
    return null;
  }

  if (normalized.length <= MAX_OPENING_NAME_LENGTH) {
    return normalized;
  }

  // Prefer a word boundary so the stored title does not end mid-token. Only
  // accept one that keeps most of the budget, otherwise a long first "word"
  // (a URL, a stack frame) would collapse the title to almost nothing.
  const clipped = normalized.slice(0, MAX_OPENING_NAME_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  const body = lastSpace >= MAX_OPENING_NAME_LENGTH / 2 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.trimEnd()}…`;
}
