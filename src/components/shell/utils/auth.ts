import { getSessionDisplayName as deriveSessionDisplayName } from '../../../utils/sessionDisplayName';
import type { ProjectSession } from '../../../types/app';

export function getSessionDisplayName(session: ProjectSession | null | undefined): string | null {
  if (!session) {
    return null;
  }

  // Shared with the sidebar and the command palette so the three cannot drift
  // apart again (#234). The shell header has no `t`, hence the literal.
  return deriveSessionDisplayName(session, 'New Session');
}
