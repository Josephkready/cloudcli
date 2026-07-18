import { Archive, Clock, Folder, FolderPlus, MessageSquare, Plus, RefreshCw, Search, X, PanelLeftClose } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu, Button, Input, Tooltip, type ActionMenuItem } from '../../../../shared/view/ui';
import { CLOUDCLI_WORDMARK_FONT_FAMILY } from '../../../../constants/branding';
import { IS_PLATFORM } from '../../../../constants/config';
import { cn } from '../../../../lib/utils';
import type { SidebarSearchMode } from '../../types/types';

const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  runningSessionsCount: number;
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  onBulkArchiveOlderThanDays: (days: number) => void;
  t: TFunction;
};

export default function SidebarHeader({
  isPWA,
  isMobile,
  isLoading,
  projectsCount,
  runningSessionsCount,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  onBulkArchiveOlderThanDays,
  t,
}: SidebarHeaderProps) {
  const showSearchTools = (projectsCount > 0 || runningSessionsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) && !isLoading;
  const searchPlaceholder = searchMode === 'conversations'
    ? t('search.conversationsPlaceholder')
    : searchMode === 'archived'
      ? t('search.archivedPlaceholder', 'Search archived sessions...')
      : t('projects.searchPlaceholder');
  const runningBadgeText = runningSessionsCount > 99 ? '99+' : String(runningSessionsCount);

  // Bulk "declutter old conversations" action. Each preset maps to a day
  // threshold; archiving is reversible from the archived view, so we confirm
  // once (naming the chosen age) rather than raising the per-session dialog.
  const bulkArchiveItems: ActionMenuItem[] = [7, 30, 90].map((days) => ({
    key: `older-than-${days}`,
    icon: Archive,
    label: t('archive.bulkByAgeOption', { days, defaultValue: 'Older than {{days}} days' }),
    onSelect: () => {
      const confirmed =
        typeof window === 'undefined' ||
        window.confirm(
          t('archive.bulkByAgeConfirm', {
            days,
            defaultValue:
              'Archive all conversations with no activity in the last {{days}} days? You can restore them anytime from the archived view.',
          }),
        );
      if (confirmed) {
        onBulkArchiveOlderThanDays(days);
      }
    },
  }));

  // Only offer the declutter action when the sidebar has projects (and thus
  // potentially archivable sessions); it no-ops harmlessly if none qualify.
  const bulkArchiveMenu = projectsCount > 0 ? (
    <div className="flex justify-end">
      <ActionMenu
        label={t('archive.bulkByAgeLabel', 'Archive older…')}
        ariaLabel={t('archive.bulkByAgeAriaLabel', 'Archive old conversations')}
        icon={Clock}
        items={bulkArchiveItems}
        variant="ghost"
        size="sm"
        align="right"
        triggerClassName="h-7 gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent/80 hover:text-foreground"
      />
    </div>
  ) : null;

  const LogoBlock = () => (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/90 shadow-sm">
        <svg className="h-3.5 w-3.5 text-primary-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <h1
        className="truncate text-sm font-bold tracking-tight text-foreground"
        style={{ fontFamily: CLOUDCLI_WORDMARK_FONT_FAMILY }}
      >
        {t('app.title')}
      </h1>
    </div>
  );

  return (
    <div className="flex-shrink-0">
      {/* Desktop header */}
      <div
        className="hidden px-3 pb-2 pt-3 md:block"
        style={{}}
      >
        <div className="flex items-center justify-between gap-2">
          {IS_PLATFORM ? (
            <a
              href="https://cloudcli.ai/dashboard"
              className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-80"
              title={t('tooltips.viewEnvironments')}
            >
              <LogoBlock />
            </a>
          ) : (
            <LogoBlock />
          )}

          <div className="flex flex-shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onRefresh}
              disabled={isRefreshing}
              title={t('tooltips.refresh')}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  isRefreshing ? 'animate-spin' : ''
                }`}
              />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCreateProject}
              title={t('tooltips.createProject')}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCollapseSidebar}
              title={t('tooltips.hideSidebar')}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Search bar */}
        {showSearchTools && (
          <div className="mt-2.5 space-y-2">
            {/* Search mode toggle */}
            <div className="flex rounded-lg bg-muted/50 p-0.5">
              <button
                onClick={() => onSearchModeChange('projects')}
                aria-pressed={searchMode === 'projects'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'projects'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Folder className="h-3 w-3" />
                {t('search.modeProjects')}
              </button>
              <button
                onClick={() => onSearchModeChange('conversations')}
                aria-pressed={searchMode === 'conversations'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'conversations'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <MessageSquare className="h-3 w-3" />
                {t('search.modeConversations')}
                {runningSessionsCount > 0 && (
                  <span
                    className="flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-semibold leading-none text-white"
                    title={t('conversations.runningBadge', 'Running sessions')}
                  >
                    {runningBadgeText}
                  </span>
                )}
              </button>
              <Tooltip content={t('search.archiveOnlyTooltip', 'Archive only')} position="top">
                <button
                  onClick={() => onSearchModeChange('archived')}
                  aria-pressed={searchMode === 'archived'}
                  aria-label={t('search.archiveOnlyTooltip', 'Archive only')}
                  title={t('search.archiveOnlyTooltip', 'Archive only')}
                  className={cn(
                    "flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-normal transition-all",
                    searchMode === 'archived'
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Archive className="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-9 rounded-xl border-0 pl-9 pr-14 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter ? (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 hover:bg-accent"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              ) : (
                <kbd
                  aria-hidden
                  title={t('tooltips.openCommandPalette')}
                  className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline-flex"
                >
                  {MOD_KEY}
                  <span>K</span>
                </kbd>
              )}
            </div>
            {bulkArchiveMenu}
          </div>
        )}
      </div>

      {/* Desktop divider */}
      <div className="nav-divider hidden md:block" />

      {/* Mobile header */}
      <div
        className="p-3 pb-2 md:hidden"
        style={isPWA && isMobile ? { paddingTop: '16px' } : {}}
      >
        <div className="flex items-center justify-between">
          {IS_PLATFORM ? (
            <a
              href="https://cloudcli.ai/dashboard"
              className="flex min-w-0 items-center gap-2.5 transition-opacity active:opacity-70"
              title={t('tooltips.viewEnvironments')}
            >
              <LogoBlock />
            </a>
          ) : (
            <LogoBlock />
          )}

          <div className="flex flex-shrink-0 gap-1.5">
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/50 transition-all active:scale-95"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={`h-4 w-4 text-muted-foreground ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/90 text-primary-foreground transition-all active:scale-95"
              onClick={onCreateProject}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mobile search */}
        {showSearchTools && (
          <div className="mt-2.5 space-y-2">
            <div className="flex rounded-lg bg-muted/50 p-0.5">
              <button
                onClick={() => onSearchModeChange('projects')}
                aria-pressed={searchMode === 'projects'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'projects'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Folder className="h-3 w-3" />
                {t('search.modeProjects')}
              </button>
              <button
                onClick={() => onSearchModeChange('conversations')}
                aria-pressed={searchMode === 'conversations'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'conversations'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <MessageSquare className="h-3 w-3" />
                {t('search.modeConversations')}
                {runningSessionsCount > 0 && (
                  <span
                    className="flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-semibold leading-none text-white"
                    title={t('conversations.runningBadge', 'Running sessions')}
                  >
                    {runningBadgeText}
                  </span>
                )}
              </button>
              <Tooltip content={t('search.archiveOnlyTooltip', 'Archive only')} position="top">
                <button
                  onClick={() => onSearchModeChange('archived')}
                  aria-pressed={searchMode === 'archived'}
                  aria-label={t('search.archiveOnlyTooltip', 'Archive only')}
                  title={t('search.archiveOnlyTooltip', 'Archive only')}
                  className={cn(
                    "flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-normal transition-all",
                    searchMode === 'archived'
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Archive className="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-10 rounded-xl border-0 pl-10 pr-9 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter && (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 hover:bg-accent"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
            {bulkArchiveMenu}
          </div>
        )}
      </div>

      {/* Mobile divider */}
      <div className="nav-divider md:hidden" />
    </div>
  );
}
