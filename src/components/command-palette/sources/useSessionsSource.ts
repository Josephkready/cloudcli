import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../utils/api';
import { getSessionDisplayName } from '../../../utils/sessionDisplayName';
import type { LLMProvider, ProjectSession } from '../../../types/app';

import { useApiSource } from './useApiSource';

export type SessionResult = {
  id: string;
  label: string;
  provider?: LLMProvider;
};

interface SessionsResponse {
  sessions?: ProjectSession[];
}

export function useSessionsSource(projectId: string | undefined, enabled: boolean) {
  const { t } = useTranslation(['sidebar', 'common']);
  // Same placeholder the sidebar renders, so one session can't be a UUID here
  // and "New Session" there (#234).
  const untitledLabel = t('projects.newSession');

  return useApiSource<SessionResult, SessionsResponse>({
    enabled: enabled && !!projectId,
    deps: [projectId, untitledLabel],
    fetcher: (signal) => {
      const params = new URLSearchParams({ limit: '50', offset: '0' });
      return authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectId!)}/sessions?${params.toString()}`,
        { signal },
      );
    },
    parse: (data) => {
      return (data.sessions ?? []).map<SessionResult>((s) => ({
        id: s.id,
        // `value` on the CommandItem still includes s.id, so search-by-id works
        // even though the visible label no longer is one.
        label: getSessionDisplayName(s, untitledLabel),
        provider: (s.__provider || s.provider) as LLMProvider | undefined,
      }));
    },
  });
}
