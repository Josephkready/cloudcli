/**
 * Shared helpers for reading a JSON API response.
 *
 * The server reports failures in three different shapes depending on the route
 * — `{ error: { message } }`, `{ error: '…' }`, and `{ details: '…' }` — so
 * every caller that wants to show the user *why* something failed has to walk
 * all three. That walk was copied into each feature hook, which meant a route
 * returning a shape one copy didn't know about degraded to a generic message
 * in one panel and a specific one in another. There is one copy now.
 */

/** Parses a response body as JSON, typed at the call site. */
export const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

/**
 * Pulls the most specific human-readable message out of an API error payload,
 * falling back to `fallback` when the payload carries nothing usable.
 */
export const getApiErrorMessage = (payload: unknown, fallback: string): string => {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  const details = record.details;
  if (typeof details === 'string' && details.trim()) {
    return details;
  }

  return fallback;
};
