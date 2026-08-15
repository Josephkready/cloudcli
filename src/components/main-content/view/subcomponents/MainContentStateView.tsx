import { useMemo } from 'react';
import { ChevronRight, Folder, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useHideCliOriginChats } from '../../../../hooks/useHideCliOriginChats';
import { buildConversationList, formatCompactAge } from '../../../sidebar/utils/conversationList';
import { filterCliOriginConversations, getSessionName } from '../../../sidebar/utils/utils';
import SidebarNewConversationButton from '../../../sidebar/view/subcomponents/SidebarNewConversationButton';
import type { MainContentStateViewProps } from '../../types/types';

import MobileMenuButton from './MobileMenuButton';

export default function MainContentStateView({
  mode,
  isMobile,
  onMenuClick,
  projects,
  activeSessions,
  onProjectSelect,
  onSessionSelect,
  onNewConversation,
}: MainContentStateViewProps) {
  const { t } = useTranslation();
  // A second, sidebar-scoped `t` purely for SidebarNewConversationButton, whose
  // `conversations.*` keys live in the `sidebar` namespace while this view's own
  // `mainContent.*` copy lives in `common`. The default `t` resolves `common`
  // only — there is no `fallbackNS` — so handing it to that button would miss
  // every one of its keys and silently render the inline English defaults,
  // decoupling its copy from the locale file that owns it. Two scoped `t`s
  // rather than `useTranslation(['sidebar', 'common'])`: a bare key resolves
  // against the FIRST namespace only, so the array form breaks `mainContent.*`.
  const { t: tSidebar } = useTranslation('sidebar');
  const hideCliOriginChats = useHideCliOriginChats();

  const isLoading = mode === 'loading';

  // #326: on mobile the sidebar is behind the burger menu, so "select a project
  // from the sidebar" pointed at something the user could not see and the
  // landing page was a dead end.
  //
  // What you actually come back to resume is a conversation, so that is what
  // the landing page offers. Built with the sidebar's own helpers rather than a
  // second implementation, so the ordering ("what needs me now": Plan >
  // Blocked > Done > Running > Recent) and the CLI-origin filtering match the
  // sidebar exactly instead of drifting from it.
  const conversations = useMemo(
    () =>
      filterCliOriginConversations(
        buildConversationList(projects ?? [], activeSessions ?? new Map(), null),
        hideCliOriginChats,
      ),
    [projects, activeSessions, hideCliOriginChats],
  );

  const canPick = !isLoading && isMobile;
  const showConversationPicker = canPick && Boolean(onSessionSelect) && conversations.length > 0;
  // Nothing to resume yet (a first run, or every conversation filtered out):
  // offer the projects instead, so the page still leads somewhere.
  const showProjectPicker =
    canPick && !showConversationPicker && Boolean(onProjectSelect) && (projects?.length ?? 0) > 0;

  return (
    <div className="flex h-full flex-col">
      {isMobile && (
        <div className="pwa-header-safe flex-shrink-0 border-b border-border/50 bg-background/80 p-2 sm:p-3">
          <MobileMenuButton onMenuClick={onMenuClick} compact />
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-10 w-10">
              <div
                className="h-full w-full rounded-full border-[3px] border-muted border-t-primary"
                style={{
                  animation: 'spin 1s linear infinite',
                  WebkitAnimation: 'spin 1s linear infinite',
                  MozAnimation: 'spin 1s linear infinite',
                }}
              />
            </div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">{t('mainContent.loading')}</h2>
            <p className="text-sm">{t('mainContent.settingUpWorkspace')}</p>
          </div>
        </div>
      ) : showConversationPicker ? (
        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="mx-auto w-full max-w-md">
            <h2 className="mb-1 text-lg font-semibold text-foreground">{t('mainContent.chooseConversation')}</h2>
            <p className="mb-4 text-sm text-muted-foreground">{t('mainContent.tapConversationToOpen')}</p>
            {/*
              #331: the list only let you RESUME a conversation. Starting one
              meant opening the burger menu and finding the sidebar's button, so
              the landing page was missing its other half. This is that same
              button, not a second implementation, so the picker it opens keeps
              the sidebar's ordering of the folders you can start in.

              It is deliberately given no create-project handler: that flow is
              the sidebar's own state and is unreachable from here, so the
              component drops its "New project…" item rather than rendering one
              that does nothing. Nothing is lost — this branch only renders when
              there is already at least one project to start in.
            */}
            {onNewConversation && (
              <SidebarNewConversationButton
                projects={projects ?? []}
                onNewConversation={onNewConversation}
                className="mb-4"
                t={tSidebar}
              />
            )}
            <ul className="space-y-2">
              {conversations.map(({ project, session, activityTime }) => {
                const age = formatCompactAge(activityTime, new Date());
                return (
                  <li key={`${project.projectId}:${session.id}`}>
                    <button
                      type="button"
                      data-testid="mobile-conversation-option"
                      onClick={() => {
                        // Both, and in this order — the sidebar does the same.
                        // Selecting only the session would leave the app with no
                        // project context; the `__projectId` tag is what lets
                        // downstream handlers correlate the two.
                        onProjectSelect?.(project);
                        onSessionSelect?.({ ...session, __projectId: project.projectId });
                      }}
                      className="flex w-full touch-manipulation items-center gap-3 rounded-xl border border-border/60 bg-card p-3 text-left transition-colors active:bg-accent/60"
                    >
                      <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted/50">
                        <MessageSquare className="h-4 w-4 text-muted-foreground" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {getSessionName(session, t)}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {project.displayName}
                          {age ? ` · ${age}` : ''}
                        </span>
                      </span>
                      <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : showProjectPicker ? (
        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="mx-auto w-full max-w-md">
            <h2 className="mb-1 text-lg font-semibold text-foreground">{t('mainContent.chooseProject')}</h2>
            <p className="mb-4 text-sm text-muted-foreground">{t('mainContent.tapProjectToOpen')}</p>
            <ul className="space-y-2">
              {projects?.map((project) => (
                <li key={project.projectId}>
                  <button
                    type="button"
                    data-testid="mobile-project-option"
                    onClick={() => onProjectSelect?.(project)}
                    className="flex w-full touch-manipulation items-center gap-3 rounded-xl border border-border/60 bg-card p-3 text-left transition-colors active:bg-accent/60"
                  >
                    <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted/50">
                      <Folder className="h-4 w-4 text-muted-foreground" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {project.displayName}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {project.path || project.fullPath}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-md px-6 text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50">
              <Folder className="h-7 w-7 text-muted-foreground" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-foreground">{t('mainContent.chooseProject')}</h2>
            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">{t('mainContent.selectProjectDescription')}</p>
            <div className="rounded-xl border border-primary/10 bg-primary/5 p-3.5">
              <p className="text-sm text-primary">
                <strong>{t('mainContent.tip')}:</strong> {isMobile ? t('mainContent.createProjectMobile') : t('mainContent.createProjectDesktop')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
