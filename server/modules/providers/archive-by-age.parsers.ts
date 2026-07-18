import { AppError } from '@/shared/utils.js';

/**
 * Reject any `days` input that is not a positive, finite number. Shared by the
 * body and query parsers so both bulk archive-by-age endpoints
 * (`POST /sessions/archive-by-age` and `GET /sessions/archivable-count`) agree
 * on what a valid age is, and surface the same 400.
 */
function assertPositiveFiniteDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) {
    throw new AppError('days must be a positive number.', {
      code: 'INVALID_ARCHIVE_AGE',
      statusCode: 400,
    });
  }

  return days;
}

/**
 * Parse the `{ days }` JSON body of `POST /sessions/archive-by-age`. Requires an
 * actual number — no string/array coercion — so surprising inputs like
 * `{ days: [7] }` (which `Number()` would quietly coerce to 7) are rejected
 * rather than silently accepted.
 */
export function parseArchiveByAgeDays(payload: unknown): number {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const days = (payload as Record<string, unknown>).days;
  if (typeof days !== 'number') {
    throw new AppError('days must be a positive number.', {
      code: 'INVALID_ARCHIVE_AGE',
      statusCode: 400,
    });
  }

  return assertPositiveFiniteDays(days);
}

/**
 * Query-string twin of `parseArchiveByAgeDays` for `GET /sessions/archivable-count`.
 * Query params always arrive as strings (or, for a repeated key, a string
 * array), so parse-then-validate a numeric `?days=` rather than requiring a JSON
 * number. A missing, empty/whitespace, array, or non-numeric value is rejected.
 */
export function parseArchiveByAgeDaysQuery(value: unknown): number {
  const raw = typeof value === 'string' ? value.trim() : '';
  const days = raw.length > 0 ? Number(raw) : NaN;
  return assertPositiveFiniteDays(days);
}
