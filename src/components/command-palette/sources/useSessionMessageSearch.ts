import { useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import { streamAuthenticatedSse } from '../../../utils/sse';
import type { LLMProvider } from '../../../types/app';

export type SessionMessageMatch = {
  sessionId: string;
  label: string;
  snippet: string;
  provider: LLMProvider;
};

type ProjectResult = {
  projectId: string | null;
  projectName: string;
  sessions: Array<{
    sessionId: string;
    provider: LLMProvider;
    sessionSummary: string;
    matches: Array<{ snippet: string }>;
  }>;
};

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

export function useSessionMessageSearch(
  projectId: string | undefined,
  query: string,
  enabled: boolean,
) {
  const [items, setItems] = useState<SessionMessageMatch[]>([]);
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || !projectId || trimmed.length < MIN_QUERY) {
      setItems([]);
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }

    abortRef.current?.abort();
    abortRef.current = null;
    seqRef.current++;

    const handle = setTimeout(() => {
      const seq = ++seqRef.current;
      const url = api.searchConversationsUrl(trimmed);
      const controller = new AbortController();
      abortRef.current = controller;
      const accumulated: SessionMessageMatch[] = [];

      const finish = () => {
        if (seq !== seqRef.current) return;
        controller.abort();
        if (abortRef.current === controller) abortRef.current = null;
      };

      void streamAuthenticatedSse(url, (event) => {
        if (seq !== seqRef.current) {
          controller.abort();
          return;
        }
        if (event.event === 'done' || event.event === 'error') {
          finish();
          return;
        }
        if (event.event !== 'result') return;
        try {
          const data = JSON.parse(event.data) as { projectResult: ProjectResult };
          const pr = data.projectResult;
          if (pr.projectId !== projectId) return;
          for (const s of pr.sessions) {
            accumulated.push({
              sessionId: s.sessionId,
              label: s.sessionSummary || s.sessionId,
              snippet: s.matches[0]?.snippet ?? '',
              provider: s.provider,
            });
          }
          setItems([...accumulated]);
        } catch {
          // ignore malformed
        }
      }, { signal: controller.signal }).then(finish).catch(() => {
        if (!controller.signal.aborted) finish();
      });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(handle);
    };
  }, [projectId, query, enabled]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  return items;
}
