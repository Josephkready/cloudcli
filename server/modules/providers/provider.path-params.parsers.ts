// Pure request-parsing helpers for the provider routes' path parameters.
//
// These validate `:param` path segments at the HTTP boundary and throw
// `AppError` (HTTP 400) on bad input. They live here — away from
// `provider.routes.ts`, which pulls in the whole service graph on import — so
// they can be unit-tested directly against their edge cases without booting the
// server. See `provider.path-params.parsers.test.ts`.
//
// This is the security-relevant cluster: `parseSessionId` in particular gates
// user-supplied ids against a strict allow-list pattern before they reach the
// filesystem/session layer, so its boundaries are pinned by tests. Part of the
// `*.parsers.ts` family (see `provider.routes.parsers.ts`,
// `archive-by-age.parsers.ts`).

import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Read a required path parameter as a string. Express normally surfaces a
 * `:param` as a string, but a repeated segment can arrive as an array — take
 * the first string entry in that case, and reject anything else (missing,
 * non-string) with a 400.
 */
export const readPathParam = (value: unknown, name: string): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  throw new AppError(`${name} path parameter is invalid.`, {
    code: 'INVALID_PATH_PARAMETER',
    statusCode: 400,
  });
};

/** Read the `:provider` path param and normalize it (trim + lowercase). */
export const normalizeProviderParam = (value: unknown): string =>
  readPathParam(value, 'provider').trim().toLowerCase();

/**
 * Allowed shape of a session id: 1–120 chars of `[A-Za-z0-9._-]`. Deliberately
 * excludes path separators and whitespace so a user-supplied id can't be used
 * for path traversal downstream.
 */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

/**
 * Reserved dot-only names. `.` is an allow-list character (needed for ids like
 * `v2.0`), so bare `.` / `..` (and any all-dots id) slip past
 * `SESSION_ID_PATTERN`. On their own they can't traverse — `/` is rejected — but
 * a lone `..` used as a single path segment downstream (`path.join(base, id)`)
 * would resolve to `base`'s parent, so reject them defensively here.
 */
const RESERVED_DOT_ONLY_ID = /^\.+$/;

/**
 * Parse and validate a `:sessionId` path param against `SESSION_ID_PATTERN`.
 * Trims first, then rejects empty, over-length (>120), reserved dot-only names
 * (`.`, `..`), or traversal/whitespace-bearing ids with a 400.
 */
export const parseSessionId = (value: unknown): string => {
  const sessionId = readPathParam(value, 'sessionId').trim();
  if (!SESSION_ID_PATTERN.test(sessionId) || RESERVED_DOT_ONLY_ID.test(sessionId)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }

  return sessionId;
};

/**
 * Parse the `:provider` path param into a supported `LLMProvider`, normalizing
 * case/whitespace first. Anything outside the allow-list throws a 400.
 */
export const parseProvider = (value: unknown): LLMProvider => {
  const normalized = normalizeProviderParam(value);
  if (
    normalized === 'claude'
    || normalized === 'codex'
  ) {
    return normalized;
  }

  throw new AppError(`Unsupported provider "${normalized}".`, {
    code: 'UNSUPPORTED_PROVIDER',
    statusCode: 400,
  });
};
