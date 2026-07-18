import type { ClaudeSettings } from '../types/types';

export const CLAUDE_SETTINGS_KEY = 'claude-settings';

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old data');

        const keys = Object.keys(localStorage);
        const draftKeys = keys.filter((k) => k.startsWith('draft_input_') || k.startsWith('queued_message_'));
        draftKeys.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
        }
      } else {
        console.error('localStorage error:', error);
      }
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

export function writeQueuedMessages(sessionId: string, messages: StoredQueuedMessage[]): void {
  const serialized = serializeQueuedMessages(messages);
  if (serialized === null) {
    safeLocalStorage.removeItem(queuedMessageKey(sessionId));
  } else {
    safeLocalStorage.setItem(queuedMessageKey(sessionId), serialized);
  }
}

export function clearQueuedMessages(sessionId: string): void {
  safeLocalStorage.removeItem(queuedMessageKey(sessionId));
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
      projectSortOrder: 'name',
    };
  }
}
