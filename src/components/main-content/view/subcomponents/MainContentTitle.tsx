import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { AppTab, Project, ProjectSession } from '../../../../types/app';
import { usePlugins } from '../../../../contexts/PluginsContext';
import { resolveTitleCommit } from '../../utils/titleRename';

import CliOriginBadge from './CliOriginBadge';

type MainContentTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  onRenameSession: (sessionId: string, summary: string) => void | Promise<void>;
  isMobile?: boolean;
};

function getTabTitle(activeTab: AppTab, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'git') {
    return t('tabs.git');
  }

  return 'Project';
}

function getSessionTitle(session: ProjectSession): string {
  return (session.summary as string) || 'New Session';
}

export default function MainContentTitle({
  activeTab,
  selectedProject,
  selectedSession,
  onRenameSession,
  isMobile = false,
}: MainContentTitleProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  const sessionTitle = selectedSession ? getSessionTitle(selectedSession) : '';

  // Never keep the editor open across a session switch.
  useEffect(() => {
    setIsEditingTitle(false);
  }, [selectedSession?.id]);

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [isEditingTitle]);

  const startEditingTitle = () => {
    if (!selectedSession) {
      return;
    }
    setTitleDraft(sessionTitle);
    setIsEditingTitle(true);
  };

  const commitTitle = () => {
    setIsEditingTitle(false);
    const nextTitle = resolveTitleCommit(titleDraft, sessionTitle);
    if (selectedSession && nextTitle) {
      void onRenameSession(selectedSession.id, nextTitle);
    }
  };

  const pluginDisplayName = activeTab.startsWith('plugin:')
    ? plugins.find((p) => p.name === activeTab.replace('plugin:', ''))?.displayName
    : undefined;

  // On mobile the open-session strip directly below the header already carries
  // the session title (with its own provider logo) at nearly full width, so the
  // header collapses to the project name for context (#364) — no icon, no
  // hard-truncated duplicate title.
  const collapseToProjectName = isMobile && activeTab === 'chat' && Boolean(selectedSession);
  const showSessionIcon = activeTab === 'chat' && Boolean(selectedSession) && !collapseToProjectName;
  const showChatNewSession = activeTab === 'chat' && !selectedSession;

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {showSessionIcon && (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <SessionProviderLogo provider={selectedSession?.__provider} className="h-4 w-4" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {collapseToProjectName ? (
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-tight text-foreground">
              {selectedProject.displayName}
            </h2>
          </div>
        ) : activeTab === 'chat' && selectedSession ? (
          <div className="min-w-0">
            {isEditingTitle ? (
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitTitle();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setIsEditingTitle(false);
                  }
                }}
                onBlur={commitTitle}
                aria-label={t('mainContent.renameSession', 'Rename session')}
                className="w-full rounded border border-primary/40 bg-background px-1 py-0.5 text-sm font-semibold leading-tight text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={startEditingTitle}
                  title={t('mainContent.renameSessionHint', 'Click to rename')}
                  className="-mx-1 min-w-0 truncate rounded px-1 text-left text-sm font-semibold leading-tight text-foreground hover:bg-accent/50"
                >
                  {sessionTitle}
                </button>
                {/* Surface a terminal/CLI-started session in the opened-session
                    header (#225), reusing the sidebar's hedged badge so it no
                    longer looks identical to a cloudcli-driven run. */}
                {selectedSession.origin === 'cli' && <CliOriginBadge size="md" />}
              </div>
            )}
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : showChatNewSession ? (
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="truncate text-xs leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight text-foreground">
              {getTabTitle(activeTab, t, pluginDisplayName)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        )}
      </div>
    </div>
  );
}
