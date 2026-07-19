/**
 * Turn a failed voice-proxy Response into a human-readable message.
 *
 * The proxy (server/voice-proxy.js) already produces actionable JSON errors
 * such as `{ error: 'Voice backend unreachable: ...' }`,
 * `{ error: 'No voice backend configured' }`, or a timeout notice. Surface that
 * message instead of a bare status code so the mic tooltip tells the user what
 * actually went wrong. Falls back to `HTTP <status>` when the body carries no
 * usable error string (empty, non-JSON, or JSON without an `error` field).
 *
 * @param res A failed (`!res.ok`) fetch Response from the voice endpoints.
 * @returns The backend's error message, or `HTTP <status>` as a fallback.
 */
export async function readVoiceError(res: Response): Promise<string> {
  try {
    // clone() so a caller that also wants to read the body isn't left with a
    // consumed stream.
    const data = await res.clone().json();
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const error = (data as { error?: unknown }).error;
      if (typeof error === 'string' && error.trim()) return error.trim();
    }
  } catch {
    /* body was empty or not JSON — fall through to the status code */
  }
  return `HTTP ${res.status}`;
}
