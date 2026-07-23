import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Project, ProjectSession } from '../../../../types/app';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import { useHideCliOriginChats } from '../../../../hooks/useHideCliOriginChats';
import { PillBar, Pill, Tooltip } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { filterCliOriginSessions, getAllSessions, getSessionName } from '../../../sidebar/utils/utils';
import {
  buildSessionTabs,
  SESSION_TAB_STATUS_BORDER,
  SESSION_TAB_STATUS_DOT,
  type SessionTabViewModel,
} from '../../utils/sessionTabs';

type MainContentSessionTabsProps = {
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  processingSessions: SessionActivityMap;
  isMobile?: boolean;
  onSessionSelect: (session: ProjectSession) => void;
  onNewSession: (project: Project) => void;
};

/**
 * Per-space "open sessions" tab bar (herdr's `tabs[]`).
 *
 * On desktop this is a horizontally-scrollable row of the active space's
 * sessions, each a pill with the provider logo, title, and a live-status dot
 * (running/blocked/done via {@link buildSessionTabs}); the active pill is the
 * open session. Clicking a pill switches sessions in one click, and the trailing
 * ＋ starts a new session in the space.
 *
 * On mobile (`isMobile`) that strip degenerates into a thin horizontally
 * scrolling row of tiny tap targets, so it collapses into a single hamburger
 * button showing the active session plus an open-session count. Tapping it opens
 * a full-width overlay listing the same tabs with comfortable tap targets and
 * the ＋ action; picking a session closes the overlay and switches to it.
 *
 * Renders nothing when the space has no sessions.
 */
export default function MainContentSessionTabs({
  selectedProject,
  selectedSession,
  processingSessions,
  isMobile = false,
  onSessionSelect,
  onNewSession,
}: MainContentSessionTabsProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  // Global preference (#216): terminal-started sessions are hidden by default.
  const hideCliOriginChats = useHideCliOriginChats();
  const selectedId = selectedSession ? String(selectedSession.id) : null;
  const tabs = buildSessionTabs(
    filterCliOriginSessions(getAllSessions(selectedProject), hideCliOriginChats),
    processingSessions,
    selectedId,
  );

  useEffect(() => {
    if (isMobile) return;
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
  }, [updateScrollState, tabs.length, isMobile]);

  // Escape closes the mobile overlay and hands focus back to the trigger, which
  // is the same keyboard contract the shared ActionMenu offers. Outside taps are
  // handled by the backdrop, which also stops taps from falling through to the
  // chat underneath.
  useEffect(() => {
    if (!isMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsMenuOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [isMenuOpen]);

  // Move focus into the overlay on open so the `menu`/`menuitem` roles are
  // actually reachable by keyboard and screen readers.
  useEffect(() => {
    if (!isMenuOpen) return;
    const menu = menuRef.current;
    const firstItem = menu?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    (firstItem ?? menu)?.focus();
  }, [isMenuOpen]);

  // Switching spaces must not leave a stale overlay open over the new one.
  useEffect(() => {
    setIsMenuOpen(false);
  }, [selectedProject.projectId]);

  const selectSession = useCallback(
    (session: SessionTabViewModel['session']) => {
      setIsMenuOpen(false);
      onSessionSelect({ ...session, __projectId: selectedProject.projectId });
    },
    [onSessionSelect, selectedProject.projectId],
  );

  const startNewSession = useCallback(() => {
    setIsMenuOpen(false);
    onNewSession(selectedProject);
  }, [onNewSession, selectedProject]);

  if (tabs.length === 0) {
    return null;
  }

  const newSessionLabel = t('projects.newSessionInSpace', 'New session in this space');

  if (isMobile) {
    const activeTab = tabs.find((tab) => tab.isActive) ?? null;
    const triggerLabel = activeTab
      ? getSessionName(activeTab.session, t)
      : t('sessions.openSessions', 'Open sessions');

    return (
      <div className="relative mt-1.5">
        <div className="flex items-center gap-1">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setIsMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            aria-label={t('sessions.openSessionsMenu', 'Open sessions menu')}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/60 bg-accent/30 px-2.5 py-2 text-left text-sm text-foreground transition-colors active:bg-accent/60"
          >
            <Menu className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            {activeTab && (
              <SessionProviderLogo
                provider={activeTab.session.__provider}
                className="h-3.5 w-3.5 flex-shrink-0"
              />
            )}
            <span className="truncate">{triggerLabel}</span>
            <span className="ml-auto flex-shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs text-muted-foreground">
              {tabs.length}
            </span>
          </button>
          <button
            type="button"
            onClick={startNewSession}
            aria-label={newSessionLabel}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-accent/60"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {isMenuOpen && (
          <>
            <div className="fixed inset-0 z-40" aria-hidden onClick={() => setIsMenuOpen(false)} />
            <div
              ref={menuRef}
              role="menu"
              tabIndex={-1}
              aria-label={t('sessions.openSessions', 'Open sessions')}
              className="absolute inset-x-0 top-full z-50 mt-1 max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            >
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('sessions.openSessions', 'Open sessions')}
                </span>
                <button
                  type="button"
                  onClick={() => setIsMenuOpen(false)}
                  aria-label={t('common:buttons.close', 'Close')}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground active:bg-accent/60"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {tabs.map(({ id, isActive, status, session }) => {
                const dot = SESSION_TAB_STATUS_DOT[status];
                return (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    aria-current={isActive || undefined}
                    onClick={() => selectSession(session)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left text-sm transition-colors',
                      SESSION_TAB_STATUS_BORDER[status],
                      isActive ? 'bg-accent font-medium' : 'active:bg-accent/60',
                    )}
                  >
                    <SessionProviderLogo
                      provider={session.__provider}
                      className="h-4 w-4 flex-shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate">{getSessionName(session, t)}</span>
                    {dot && (
                      <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', dot)} aria-hidden />
                    )}
                  </button>
                );
              })}
              <div className="mx-2 my-1 h-px bg-border" />
              <button
                type="button"
                role="menuitem"
                onClick={startNewSession}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-muted-foreground active:bg-accent/60"
              >
                <Plus className="h-4 w-4 flex-shrink-0" />
                <span>{newSessionLabel}</span>
              </button>
            </div>
          </>
        )}
      </div>
    );
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
                  onClick={() => selectSession(session)}
                  className={cn('max-w-[180px] border', SESSION_TAB_STATUS_BORDER[status])}
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
      <Tooltip content={newSessionLabel} position="bottom">
        <button
          type="button"
          onClick={startNewSession}
          aria-label={newSessionLabel}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </Tooltip>
    </div>
  );
}
