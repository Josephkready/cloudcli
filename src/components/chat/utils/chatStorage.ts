import { CLAUDE_SETTINGS_KEY } from '../../../utils/claudeSettings';
import type { ClaudeSettings } from '../types/types';

// Re-exported so chat-side importers keep their existing import path; the key
// itself lives next to the change-notification helpers every writer must call.
export { CLAUDE_SETTINGS_KEY };

/**
 * The only key class quota recovery is allowed to delete.
 *
 * A `draft_input_*` value mirrors the composer's live in-memory `input` for a
 * project and is rewritten on the very next keystroke, so dropping it is a
 * cache eviction rather than a loss.
 *
 * Two key classes are deliberately NOT swept, because each is the *sole*
 * durable copy of something the user wrote:
 *   - `queued_message_*` — messages typed and queued while a turn was in
 *     flight. This key is exactly what makes the queue survive a reload, so
 *     deleting it to make room discards user writing (#330).
 *   - `pending_send_*` — messages sent but not yet echoed back by the server,
 *     kept out of the sweep when they were introduced (#327).
 *
 * Freeing less means the retry is likelier to fail. That is the intended
 * trade: a failed write is reported to the caller (and, for the queue, to the
 * user) instead of being paid for with text they cannot get back.
 */
const EVICTABLE_KEY_PREFIX = 'draft_input_';

export const safeLocalStorage = {
  /**
   * Writes a value without throwing, returning whether the value is actually
   * in storage afterwards. Callers holding the only durable copy of user text
   * check the result rather than assuming the write landed.
   */
  setItem: (key: string, value: string): boolean => {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn(`localStorage quota exceeded writing "${key}", evicting ${EVICTABLE_KEY_PREFIX}* drafts`);

        const keys = Object.keys(localStorage);
        const draftKeys = keys.filter((k) => k.startsWith(EVICTABLE_KEY_PREFIX));
        draftKeys.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
          return true;
        } catch (retryError) {
          console.error(`Failed to save "${key}" to localStorage even after evicting drafts:`, retryError);
          return false;
        }
      }
      console.error('localStorage error:', error);
      return false;
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
};

/**
 * Composer options captured when a message is queued, so the message can be
 * sent later with the exact settings (model, permission mode, tools) the
 * session's composer had at queue time — even from outside the composer,
 * e.g. the app-level auto-send that fires while another session is viewed.
 */
export type QueuedSendOptions = Record<string, unknown>;

export type StoredQueuedMessage = {
  content: string;
  options?: QueuedSendOptions;
};

export const queuedMessageKey = (sessionId: string) => `queued_message_${sessionId}`;

// Normalizes one candidate into a stored message, dropping anything without
// non-empty string content (and any `options` that isn't present).
function normalizeStoredMessage(value: unknown): StoredQueuedMessage | null {
  if (value && typeof value === 'object' && typeof (value as StoredQueuedMessage).content === 'string') {
    const { content, options } = value as StoredQueuedMessage;
    return content.trim() ? (options !== undefined ? { content, options } : { content }) : null;
  }
  return null;
}

/**
 * Parses the persisted queue for a session into an ordered list. Pure (no
 * storage access) so it can be unit-tested. Understands three formats:
 *   1. the current JSON array `[{ content, options }, ...]`
 *   2. the legacy single JSON object `{ content, options }`
 *   3. the legacy raw-text format (the draft text itself)
 * Empty/whitespace-only and malformed entries are dropped.
 */
export function parseQueuedMessages(raw: string | null): StoredQueuedMessage[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map(normalizeStoredMessage)
        .filter((message): message is StoredQueuedMessage => message !== null);
    }
    if (parsed && typeof parsed === 'object') {
      // A legacy single object in our format — honor it (or drop it if its
      // content is empty); never re-interpret our own JSON as raw text.
      const single = normalizeStoredMessage(parsed);
      return single ? [single] : [];
    }
    // Parsed to a bare primitive (number/string/bool/null): fall back to
    // treating the raw string as legacy draft text.
  } catch {
    // Not JSON — legacy raw-text format.
  }

  return raw.trim() ? [{ content: raw }] : [];
}

/**
 * Serializes a queue for storage. Pure. Returns `null` when nothing is worth
 * persisting (empty list or all entries empty), signalling the key should be
 * removed rather than written.
 */
export function serializeQueuedMessages(messages: StoredQueuedMessage[]): string | null {
  const cleaned = messages
    .map(normalizeStoredMessage)
    .filter((message): message is StoredQueuedMessage => message !== null);
  return cleaned.length ? JSON.stringify(cleaned) : null;
}

/**
 * Reads a session's ordered queue, migrating legacy single-object / raw-text
 * formats on read.
 */
export function readQueuedMessages(sessionId: string): StoredQueuedMessage[] {
  return parseQueuedMessages(safeLocalStorage.getItem(queuedMessageKey(sessionId)));
}

/**
 * Persists a session's queue, returning whether it is durable afterwards.
 * `false` means the queue now lives only in memory and will not survive a
 * reload — the caller is expected to say so rather than let it disappear
 * quietly (#330). Clearing the key always counts as durable.
 */
export function writeQueuedMessages(sessionId: string, messages: StoredQueuedMessage[]): boolean {
  const serialized = serializeQueuedMessages(messages);
  if (serialized === null) {
    safeLocalStorage.removeItem(queuedMessageKey(sessionId));
    return true;
  }
  return safeLocalStorage.setItem(queuedMessageKey(sessionId), serialized);
}

export function getClaudeSettings(): ClaudeSettings {
  const raw = safeLocalStorage.getItem(CLAUDE_SETTINGS_KEY);
  if (!raw) {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'count',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      skipPermissions: Boolean(parsed.skipPermissions),
      projectSortOrder: parsed.projectSortOrder || 'count',
    };
  } catch {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      // Match the no-settings and valid-settings defaults ('count', the
      // documented DEFAULT_PROJECT_SORT_ORDER). This branch previously returned
      // 'name', a leftover from before the default sort-order flip, so corrupt
      // settings silently disagreed with an empty store.
      projectSortOrder: 'count',
    };
  }
}
