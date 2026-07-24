import type { ProjectSession } from '../types/app';

/**
 * The one place a session's human-readable name is derived (#234).
 *
 * Three call sites used to compute this independently — the sidebar, the shell
 * header and the command palette — and they drifted: the palette fell back to
 * `session.id`, so an untitled session (there is no summary until the provider
 * writes one) rendered as a 36-character UUID in Ctrl+K while the sidebar
 * showed "New Session" for the very same session.
 *
 * `fallback` is a parameter rather than a constant because the sidebar and the
 * palette translate it, while the shell header does not have a `t` to hand.
 */
export function getSessionDisplayName(
  session: Pick<ProjectSession, 'title' | 'summary' | 'name'> | null | undefined,
  fallback: string,
): string {
  if (!session) {
    return fallback;
  }

  return session.title || session.summary || session.name || fallback;
}
