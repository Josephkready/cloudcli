/**
 * Pure logic for the on-device transcript cache (#511) — the parts that decide
 * *what* to cache, *when* a cached copy is worth keeping, and *which* sessions
 * to evict. Kept free of IndexedDB (which lives in `transcriptCache.ts`) so the
 * decisions are unit-testable without a browser database.
 *
 * The cache exists so re-opening a conversation, or scrolling back through a
 * long one, does not re-pay for history the browser already fetched (#510
 * removed the bulk-load controls that used to paper over that cost). It is only
 * ever a *paint-fast* head start: every hydrate is followed by a server
 * reconcile, so a stale cache self-corrects rather than being trusted.
 */

import type { NormalizedMessage } from './useSessionStore.pure';

/** Newest-first LRU cap on how many sessions' transcripts we keep on device. */
export const MAX_CACHED_SESSIONS = 40;

/**
 * A single session's transcript is skipped entirely once it exceeds this many
 * loaded messages. The in-conversation search jump mounts the whole thread, so
 * a single pathological conversation could otherwise blow the storage quota and
 * take the whole cache down with it (see #511's notes). Skipping the outliers
 * keeps the cache useful for the common case without risking the quota.
 */
export const MAX_CACHED_MESSAGES_PER_SESSION = 1000;

export interface CachedTranscript {
  sessionId: string;
  provider: string;
  serverMessages: NormalizedMessage[];
  hasMore: boolean;
  offset: number;
  total: number;
  /** Cheap staleness/skip-redundant-write fingerprint of `serverMessages`. */
  fingerprint: string;
  /** Wall-clock write time; the LRU key for eviction. */
  cachedAt: number;
}

/** Metadata-only view of a cached entry, for eviction decisions. */
export interface CachedTranscriptMeta {
  sessionId: string;
  cachedAt: number;
}

/**
 * A cheap, stable fingerprint of a loaded transcript. Two loads that produced
 * the same rows fingerprint identically, so a persist that would rewrite an
 * unchanged transcript can be skipped. Reads only the count and the last row's
 * identity/timestamp — enough to catch an appended or replaced tail without
 * walking every message.
 */
export function computeFingerprint(serverMessages: readonly NormalizedMessage[]): string {
  const count = serverMessages.length;
  if (count === 0) return '0';
  const last = serverMessages[count - 1];
  return `${count}:${last.id ?? ''}:${last.timestamp ?? ''}`;
}

/**
 * Whether a slot's loaded transcript is worth persisting: it must have rows,
 * and must not be one of the pathological whole-thread loads that would risk
 * the storage quota (see `MAX_CACHED_MESSAGES_PER_SESSION`).
 */
export function shouldCacheTranscript(serverMessages: readonly NormalizedMessage[]): boolean {
  return serverMessages.length > 0 && serverMessages.length <= MAX_CACHED_MESSAGES_PER_SESSION;
}

/**
 * Given every cached entry's metadata and the session (if any) currently being
 * written, return the session ids to evict so that no more than
 * `maxEntries` remain — dropping the least-recently-cached first.
 *
 * The session being written is always retained (it is what the write is for),
 * even if it is currently the oldest, so a fresh write can never evict itself.
 */
export function selectEvictions(
  metas: readonly CachedTranscriptMeta[],
  keepSessionId: string | null,
  maxEntries: number = MAX_CACHED_SESSIONS,
): string[] {
  if (metas.length <= maxEntries) return [];

  // Oldest first — the tail of this ordering is what survives.
  const ordered = [...metas].sort((a, b) => a.cachedAt - b.cachedAt);
  const evict: string[] = [];
  let remaining = ordered.length;

  for (const meta of ordered) {
    if (remaining <= maxEntries) break;
    if (meta.sessionId === keepSessionId) continue;
    evict.push(meta.sessionId);
    remaining -= 1;
  }

  return evict;
}
