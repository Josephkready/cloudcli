import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Project, ProjectSession } from '../../../../types/app';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import { PillBar, Pill, Tooltip } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { getAllSessions, getSessionName } from '../../../sidebar/utils/utils';
import { buildSessionTabs, SESSION_TAB_STATUS_DOT } from '../../utils/sessionTabs';

type MainContentSessionTabsProps = {
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  processingSessions: SessionActivityMap;
  onSessionSelect: (session: ProjectSession) => void;
  onNewSession: (project: Project) => void;
};

/**
 * Per-space "open sessions" tab bar (herdr's `tabs[]`). A horizontally-scrollable
 * row of the active space's sessions, each a pill with the provider logo, title,
 * and a live-status dot (running/blocked/done via {@link buildSessionTabs}); the
 * active pill is the open session. Clicking a pill switches sessions in one click;
 * the trailing ＋ starts a new session in the space. Renders nothing when the
 * space has no sessions.
 */
export default function MainContentSessionTabs({
  selectedProject,
  selectedSession,
  processingSessions,
  onSessionSelect,
  onNewSession,
}: MainContentSessionTabsProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  const selectedId = selectedSession ? String(selectedSession.id) : null;
  const tabs = buildSessionTabs(getAllSessions(selectedProject), processingSessions, selectedId);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    // Observe both the scroll viewport and the inner pill row: the viewport's
    // own box rarely changes, but the pill row's width does (pills added/removed
    // or a title widening), which is what actually shifts the scroll fades.
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    if (el.firstElementChild) {
      observer.observe(el.firstElementChild);
    }
    return () => observer.disconnect();
  }, [updateScrollState, tabs.length]);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="mt-1.5 flex items-center gap-1">
      <div className="relative min-w-0 flex-1 overflow-hidden">
        {canScrollLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
        )}
        <div ref={scrollRef} onScroll={updateScrollState} className="scrollbar-hide overflow-x-auto">
          <PillBar className="w-max">
            {tabs.map(({ id, isActive, status, session }) => {
              const dot = SESSION_TAB_STATUS_DOT[status];
              return (
                <Pill
                  key={id}
                  isActive={isActive}
                  onClick={() => onSessionSelect({ ...session, __projectId: selectedProject.projectId })}
                  className="max-w-[180px]"
                >
                  <SessionProviderLogo provider={session.__provider} className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="truncate">{getSessionName(session, t)}</span>
                  {dot && <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', dot)} aria-hidden />}
                </Pill>
              );
            })}
          </PillBar>
        </div>
        {canScrollRight && (
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />
        )}
      </div>
      <Tooltip content={t('projects.newSessionInSpace', 'New session in this space')} position="bottom">
        <button
          type="button"
          onClick={() => onNewSession(selectedProject)}
          aria-label={t('projects.newSessionInSpace', 'New session in this space')}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </Tooltip>
    </div>
  );
}
