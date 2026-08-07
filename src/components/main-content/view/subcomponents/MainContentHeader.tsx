import { useCallback, useRef, useState, useEffect } from 'react';
import { Archive, Bug } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '../../../../shared/view/ui';
import type { MainContentHeaderProps } from '../../types/types';
import { recordFeatureUse } from '../../../../utils/featureUsage';
import BugReportDialog from '../../../bug-report/BugReportDialog';

import MobileMenuButton from './MobileMenuButton';
import MainContentTabSwitcher from './MainContentTabSwitcher';
import MainContentTitle from './MainContentTitle';
import MainContentSessionTabs from './MainContentSessionTabs';

export default function MainContentHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  isMobile,
  onMenuClick,
  processingSessions,
  onSessionSelect,
  onNewSession,
  onRenameSession,
  onArchiveSession,
}: MainContentHeaderProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);

  // The reporter is always reachable — a bug worth filing is often one that
  // left the app in a state where nothing else works.
  const handleReportBugClick = useCallback(() => {
    recordFeatureUse('bug_report.open');
    setBugReportOpen(true);
  }, []);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  // Soft-archive the open conversation. No confirmation: archiving is
  // recoverable from the archived-sessions view, and the shared handler
  // deselects the session so the view returns to its empty state.
  const handleArchiveClick = useCallback(() => {
    if (!selectedSession) return;
    recordFeatureUse('session.archive');
    void onArchiveSession(selectedSession.id);
  }, [onArchiveSession, selectedSession]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateScrollState]);

  return (
    <div className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          <MainContentTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            onRenameSession={onRenameSession}
          />
        </div>

        <div className="flex items-center gap-1">
          <Tooltip content={t('mainContent.reportBugTooltip')} position="bottom">
            <button
              type="button"
              onClick={handleReportBugClick}
              aria-label={t('mainContent.reportBug')}
              className="flex-shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <Bug className="h-4 w-4" />
            </button>
          </Tooltip>

          {selectedSession && (
            <Tooltip content={t('mainContent.archiveSessionTooltip')} position="bottom">
              <button
                type="button"
                onClick={handleArchiveClick}
                aria-label={t('mainContent.archiveSession')}
                className="flex-shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                <Archive className="h-4 w-4" />
              </button>
            </Tooltip>
          )}

          <div className="relative min-w-0 flex-shrink overflow-hidden sm:flex-shrink-0">
            {canScrollLeft && (
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
            )}
            <div
              ref={scrollRef}
              onScroll={updateScrollState}
              className="scrollbar-hide overflow-x-auto"
            >
              <MainContentTabSwitcher
                activeTab={activeTab}
                setActiveTab={setActiveTab}
              />
            </div>
            {canScrollRight && (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />
            )}
          </div>
        </div>
      </div>

      {/* Per-space "open sessions" tab bar (renders nothing when the space has
          no sessions). */}
      <MainContentSessionTabs
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        processingSessions={processingSessions}
        isMobile={isMobile}
        onSessionSelect={onSessionSelect}
        onNewSession={onNewSession}
      />

      <BugReportDialog
        open={bugReportOpen}
        onOpenChange={setBugReportOpen}
        activeTab={activeTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
      />
    </div>
  );
}
