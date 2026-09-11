import type { ChatMessage } from '../types/types';

import { getIntrinsicMessageKey } from './messageKeys';

/**
 * Structural (deep) value equality for the plain-data ChatMessage shape.
 *
 * ChatMessage objects are JSON-like (strings, numbers, booleans, arrays, nested
 * plain objects) plus the occasional Date (`timestamp`, subagent child-tool
 * timestamps). Dates are compared by their instant so a rebuilt-but-identical
 * message still counts as equal.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // Two NaNs are the same value for reuse purposes (`a === b` is false for NaN).
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!valuesEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

// Bucket key for messages with no intrinsic key. Every real key returned by
// getIntrinsicMessageKey starts with "message-", so this plain sentinel can
// never collide with one.
const NULL_KEY = 'no-intrinsic-key';

/**
 * Preserve object identity for unchanged chat messages across store-driven
 * re-derivations.
 *
 * `normalizedToChatMessages` reuses its previous output for rows whose
 * underlying `NormalizedMessage` is unchanged (a per-row cache — see that
 * function), but a cache miss — first render, a transcript replace/compaction,
 * or a `tool_use` row whose resolved result changed — still mints a fresh
 * object. `MessageComponent` is `React.memo`'d on those props, so any of those
 * fresh identities would defeat the memo and re-render the whole visible list
 * on every delta — the CPU churn that makes scrolling choppy while an agent is
 * working (and pointlessly re-parses markdown/diffs for messages that did not
 * change) — if this pass didn't paper back over them.
 *
 * This pass rewrites `next` so that any message whose value is unchanged reuses
 * the `previous` render's object reference. Only genuinely changed messages
 * (the streaming message, a tool_use that just received its result, …) keep a
 * fresh identity and re-render. Messages are matched by intrinsic key with an
 * occurrence queue — the same disambiguation ChatMessagesPane already uses for
 * React list keys — so reuse survives prepends (pagination) and mid-list
 * inserts, not just appends.
 *
 * Purely a referential optimization: the returned array always has the same
 * length, order, and per-element values as `next`. A missed reuse only costs an
 * extra render; it can never surface stale content.
 */
export function stabilizeMessageIdentities(
  previous: ChatMessage[],
  next: ChatMessage[],
): ChatMessage[] {
  if (previous.length === 0 || next.length === 0) return next;

  // key -> FIFO queue of previous messages sharing that key, in original order.
  const byKey = new Map<string, ChatMessage[]>();
  for (const message of previous) {
    const key = getIntrinsicMessageKey(message) ?? NULL_KEY;
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(message);
    } else {
      byKey.set(key, [message]);
    }
  }

  let reusedAny = false;
  const result = next.map((message) => {
    const key = getIntrinsicMessageKey(message) ?? NULL_KEY;
    const bucket = byKey.get(key);
    if (bucket && bucket.length > 0) {
      const candidate = bucket[0];
      if (valuesEqual(candidate, message)) {
        // Consume this candidate so a later identical message can't reuse it
        // again (one previous ref backs at most one next message).
        bucket.shift();
        reusedAny = true;
        return candidate;
      }
    }
    return message;
  });

  // If nothing was reusable, return `next` itself so callers can cheaply detect
  // "no stabilization happened" by reference and avoid churning downstream refs.
  return reusedAny ? result : next;
}
