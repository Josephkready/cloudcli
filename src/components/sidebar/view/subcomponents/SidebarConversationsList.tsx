import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Activity, AlertCircle, Check, CheckCircle2, Clock, Edit2, Loader2, MessageSquare, Terminal, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import { CursorContextMenu } from '../../../../shared/view/ui';
import type { LLMProvider, Project, ProjectSession } from '../../../../types/app';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import { useHideCliOriginChats } from '../../../../hooks/useHideCliOriginChats';
import type { SessionWithProvider } from '../../types/types';
import { buildConversationList, formatCompactAge, STATUS_ORDER, type ConversationListItem, type ConversationStatus } from '../../utils/conversationList';
import { buildSessionContextMenuActions } from '../../utils/sessionContextMenu';
import { filterCliOriginConversations, getSessionName, writeHideCliOriginChats } from '../../utils/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

import SidebarNewConversationButton from './SidebarNewConversationButton';

// Rename + archive/delete handlers, shared with the Projects view's
// SidebarSessionItem. Threaded through unchanged from useSidebarController so a
// conversation row archives/renames exactly like a project's session row.
type SessionRowActions = {
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onDeleteSession: (projectName: string, sessionId: string, sessionTitle: string, provider: LLMProvider) => void;
  onArchiveSession: (sessionId: string) => void;
};

type SidebarConversationsListProps = SessionRowActions & {
  projects: Project[];
  activeSessions: SessionActivityMap;
  selectedSession: ProjectSession | null;
  currentTime: Date;
  onSelect: (session: SessionWithProvider, project: Project) => void;
  // Launches a new conversation in the chosen project (wired to handleNewSession).
  onNewConversation: (project: Project) => void;
  // Opens the create-project flow, for starting a conversation in a new folder.
  onCreateProject: () => void;
  t: TFunction;
};

type SectionMeta = {
  icon: typeof Activity;
  iconClassName: string;
  labelKey: string;
  labelFallback: string;
};

// Presentation metadata per status band, keyed so rendering walks STATUS_ORDER
// (the single ordering source in conversationList.ts) instead of a parallel list.
const SECTION_META: Record<ConversationStatus, SectionMeta> = {
  blocked: { icon: AlertCircle, iconClassName: 'text-amber-500', labelKey: 'conversations.blockedHeader', labelFallback: 'Blocked' },
  done: { icon: CheckCircle2, iconClassName: 'text-sky-500', labelKey: 'conversations.doneHeader', labelFallback: 'Done' },
  running: { icon: Activity, iconClassName: 'text-emerald-500', labelKey: 'conversations.runningHeader', labelFallback: 'Running' },
  recent: { icon: Clock, iconClassName: 'text-muted-foreground', labelKey: 'conversations.recentHeader', labelFallback: 'Recent' },
};

function ConversationRow({
  item,
  isSelected,
  currentTime,
  onSelect,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onDeleteSession,
  onArchiveSession,
  t,
}: SessionRowActions & {
  item: ConversationListItem;
  isSelected: boolean;
  currentTime: Date;
  onSelect: (session: SessionWithProvider, project: Project) => void;
  t: TFunction;
}) {
  const { project, session, status } = item;
  const title = getSessionName(session, t);
  const projectName = project.displayName || project.projectId;
  const compactAge = formatCompactAge(item.activityTime, currentTime);
  const isEditing = editingSession === session.id;
  // A blocked-but-running session ranks as `blocked` (not `running`), so gate
  // the destructive action on the live-run flag — never on the ranking band —
  // to avoid exposing archive/delete for an in-flight session (matches the
  // Projects view, which hides it while processing).
  const isActive = item.isActive;
  const editingContainerRef = useRef<HTMLDivElement>(null);

  // The rename panel lives in a group-hover opacity wrapper, so leaving the row
  // would visually hide it. While editing, dismiss only on a click outside the
  // panel (matches Escape / cancel). Mirrors SidebarSessionItem.
  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const container = editingContainerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onCancelEditingSession();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isEditing, onCancelEditingSession]);

  const saveEditedSession = () => {
    onSaveEditingSession(project.projectId, session.id, editingSessionName, session.__provider);
  };
  const requestDeleteSession = () => {
    onDeleteSession(project.projectId, session.id, title, session.__provider);
  };
  const requestArchiveSession = () => {
    onArchiveSession(session.id);
  };

  // Right-click menu mirrors the hover cluster's actions and gating: rename plus,
  // for an idle session, archive/delete. It also keeps the "open in new tab"
  // affordance the row's <a href> otherwise gives up when we intercept the menu.
  const contextMenuActions = useMemo(
    () =>
      buildSessionContextMenuActions({
        isActive,
        labels: {
          openInNewTab: t('sessionContext.openInNewTab', 'Open in new tab'),
          rename: t('sessionContext.rename', 'Rename'),
          archive: t('sessionContext.archive', 'Archive'),
          delete: t('sessionContext.delete', 'Delete permanently'),
        },
        handlers: {
          onOpenInNewTab: () => window.open(`/session/${session.id}`, '_blank', 'noopener,noreferrer'),
          onRename: () => onStartEditingSession(session.id, title),
          onArchive: requestArchiveSession,
          onDelete: requestDeleteSession,
        },
      }),
    // The action closures capture the archive/delete/rename handlers, which all
    // resolve to stable setters or useCallback-wrapped handlers, so an omitted
    // handler dep can't go stale in a way that matters. Rebuild only when the
    // gating flag, session identity, name, or translations change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isActive, session.id, title, t],
  );

  let statusIndicator: ReactNode = null;
  if (status === 'blocked') {
    statusIndicator = (
      <span
        role="status"
        aria-label={t('conversations.blockedStatus', 'Blocked — needs you')}
        title={t('conversations.blockedStatus', 'Blocked — needs you')}
        className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-amber-500"
      />
    );
  } else if (status === 'running') {
    statusIndicator = (
      <Loader2
        aria-label={t('conversations.runningStatus', 'Working')}
        className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-emerald-500"
      />
    );
  } else if (status === 'done') {
    statusIndicator = (
      <CheckCircle2
        aria-label={t('conversations.doneStatus', 'Done — unreviewed')}
        className="h-3.5 w-3.5 flex-shrink-0 text-sky-500"
      />
    );
  } else if (compactAge) {
    statusIndicator = <span className="flex-shrink-0 text-[11px] text-muted-foreground">{compactAge}</span>;
  }

  return (
    <div className="group relative">
      <CursorContextMenu
        items={contextMenuActions}
        ariaLabel={t('sessionContext.menuLabel', 'Session actions')}
      >
      <a
        href={`/session/${session.id}`}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md border p-2 text-left transition-all duration-150',
          isSelected
            ? 'border-primary bg-primary/15 ring-1 ring-primary/50 dark:bg-primary/25'
            : status === 'blocked'
              ? 'border-amber-500/30 bg-amber-50/10 hover:bg-amber-50/20 dark:bg-amber-900/5 dark:hover:bg-amber-900/10'
              : status === 'running'
                ? 'border-emerald-500/30 bg-emerald-50/10 hover:bg-emerald-50/20 dark:bg-emerald-900/5 dark:hover:bg-emerald-900/10'
                : status === 'done'
                  ? 'border-sky-500/30 bg-sky-50/10 hover:bg-sky-50/20 dark:bg-sky-900/5 dark:hover:bg-sky-900/10'
                  : 'border-border/30 bg-card hover:bg-accent/50',
        )}
        // Left-click keeps in-app navigation; Ctrl/Cmd/middle-click still open the
        // session in a new tab via the href. Right-click opens the custom session
        // menu, which offers "Open in new tab" so that affordance isn't lost.
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            return;
          }
          event.preventDefault();
          onSelect(session, project);
        }}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-muted/50">
          <SessionProviderLogo provider={session.__provider} className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-normal text-foreground">{title}</span>
          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            {/* Mark sessions cloudcli isn't driving (#71): cloudcli only sees them
                through the transcript file, so their live status is unknown.
                cloudcli-driven sessions stay unbadged (the common in-app case).
                Copy is hedged because the id-match heuristic also catches rows
                that predate provider-id tracking — see mapSessionRowToSummary. */}
            {session.origin === 'cli' && (
              <span
                className="flex flex-shrink-0 items-center gap-0.5 rounded-sm bg-muted px-1 text-[9px] font-medium uppercase leading-tight tracking-wide text-muted-foreground/80"
                title={t(
                  'conversations.cliOriginTooltip',
                  "Not driven by cloudcli — started from a terminal/CLI (or created before session tracking), so its live status is unknown",
                )}
                aria-label={t('conversations.cliOrigin', 'Session not driven by cloudcli')}
              >
                <Terminal className="h-2 w-2" aria-hidden="true" />
                {t('conversations.cliOriginBadge', 'CLI')}
              </span>
            )}
            <MessageSquare className="h-2.5 w-2.5 flex-shrink-0 opacity-70" />
            <span className="truncate">{projectName}</span>
          </span>
        </span>
        {statusIndicator && (
          <span
            className={cn(
              'flex flex-shrink-0 items-center transition-opacity duration-200',
              isEditing ? 'opacity-0' : 'group-hover:opacity-0',
            )}
          >
            {statusIndicator}
          </span>
        )}
      </a>
      </CursorContextMenu>

      {/* Rename + archive/delete cluster: sibling of the <a> so its clicks never
          navigate. Fades in on hover (stays visible while editing). */}
      <div
        ref={editingContainerRef}
        className={cn(
          'absolute right-2 top-1/2 flex -translate-y-1/2 transform items-center gap-1 transition-all duration-200',
          isEditing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        {isEditing ? (
          <>
            <input
              type="text"
              value={editingSessionName}
              onChange={(event) => onEditingSessionNameChange(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  saveEditedSession();
                } else if (event.key === 'Escape') {
                  onCancelEditingSession();
                }
              }}
              onClick={(event) => event.stopPropagation()}
              className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              autoFocus
            />
            <button
              className="flex h-6 w-6 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
              onClick={(event) => {
                event.stopPropagation();
                saveEditedSession();
              }}
              title={t('tooltips.save')}
            >
              <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
            </button>
            <button
              className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
              onClick={(event) => {
                event.stopPropagation();
                onCancelEditingSession();
              }}
              title={t('tooltips.cancel')}
            >
              <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
            </button>
          </>
        ) : (
          <>
            <button
              className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
              onClick={(event) => {
                event.stopPropagation();
                onStartEditingSession(session.id, title);
              }}
              title={t('tooltips.editSessionName')}
            >
              <Edit2 className="h-3 w-3 text-gray-600 dark:text-gray-400" />
            </button>
            {!isActive && (
              <button
                className="flex h-6 w-6 items-center justify-center rounded bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40"
                onClick={(event) => {
                  event.stopPropagation();
                  // Plain click archives in one step (the right default); shift-click
                  // opens the archive/permanent-delete dialog for a hard delete.
                  if (event.shiftKey) {
                    requestDeleteSession();
                  } else {
                    requestArchiveSession();
                  }
                }}
                title={t('tooltips.archiveSession', 'Archive session (shift-click to delete permanently)')}
              >
                <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Subtle affordance shown when the "hide CLI-origin chats" preference (#216) is
// filtering one or more sessions out of this list. Without it, a user whose
// conversations are mostly terminal-started sees only the "No conversations yet"
// empty state and the hidden sessions are undiscoverable. "Show" flips the same
// global preference off (single source of truth) rather than adding a local one.
function HiddenCliChatsRow({
  count,
  onShow,
  t,
}: {
  count: number;
  onShow: () => void;
  t: TFunction;
}) {
  return (
    <div className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground">
      <Terminal className="h-3 w-3 flex-shrink-0 opacity-70" aria-hidden="true" />
      <span>
        {count} {t('conversations.cliChatsHidden', 'CLI chats hidden')}
      </span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        onClick={onShow}
        className="rounded-sm font-medium text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        {t('conversations.showCliChats', 'Show')}
      </button>
    </div>
  );
}

export default function SidebarConversationsList({
  projects,
  activeSessions,
  selectedSession,
  currentTime,
  onSelect,
  onNewConversation,
  onCreateProject,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onDeleteSession,
  onArchiveSession,
  t,
}: SidebarConversationsListProps) {
  const selectedSessionId = selectedSession?.id ?? null;
  // Global preference (#216): terminal-started sessions are hidden by default.
  const hideCliOriginChats = useHideCliOriginChats();
  const allItems = useMemo(
    () => buildConversationList(projects, activeSessions, selectedSessionId),
    [projects, activeSessions, selectedSessionId],
  );
  const items = useMemo(
    () => filterCliOriginConversations(allItems, hideCliOriginChats),
    [allItems, hideCliOriginChats],
  );
  // filterCliOriginConversations only ever removes origin==='cli' rows, so the
  // drop between the full and filtered lists is exactly the hidden CLI count.
  const hiddenCliCount = hideCliOriginChats ? allItems.length - items.length : 0;

  // "Show" flips the global preference off; the shared useHideCliOriginChats
  // reader picks up the synthetic storage event and re-renders this list.
  const handleShowCliChats = useCallback(() => {
    writeHideCliOriginChats(false);
  }, []);

  if (items.length === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
          <MessageSquare className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
          {t('conversations.emptyTitle', 'No conversations yet')}
        </h3>
        <p className="mb-4 text-sm text-muted-foreground md:mb-3">
          {t('conversations.emptyDescription', 'Start a new conversation and it will appear here.')}
        </p>
        <div className="flex justify-center">
          <SidebarNewConversationButton
            projects={projects}
            onNewConversation={onNewConversation}
            onCreateProject={onCreateProject}
            t={t}
          />
        </div>
        {hiddenCliCount > 0 && (
          <div className="mt-4 md:mt-3">
            <HiddenCliChatsRow count={hiddenCliCount} onShow={handleShowCliChats} t={t} />
          </div>
        )}
      </div>
    );
  }

  const itemsByStatus = new Map<ConversationStatus, ConversationListItem[]>();
  for (const status of STATUS_ORDER) {
    itemsByStatus.set(status, []);
  }
  for (const item of items) {
    itemsByStatus.get(item.status)?.push(item);
  }

  return (
    <div className="space-y-3 px-2 pb-safe-area-inset-bottom">
      <div className="px-1 pt-1">
        <SidebarNewConversationButton
          projects={projects}
          onNewConversation={onNewConversation}
          onCreateProject={onCreateProject}
          t={t}
        />
      </div>
      {STATUS_ORDER.map((status) => {
        const sectionItems = itemsByStatus.get(status) ?? [];
        if (sectionItems.length === 0) {
          return null;
        }
        const meta = SECTION_META[status];
        const SectionIcon = meta.icon;

        return (
          <div key={status} className="space-y-1">
            <div className="flex items-center gap-1.5 px-1 py-1">
              <SectionIcon className={cn('h-3 w-3 flex-shrink-0', meta.iconClassName)} />
              <span className="text-xs font-medium text-foreground">{t(meta.labelKey, meta.labelFallback)}</span>
              <span className="text-[11px] text-muted-foreground">{sectionItems.length}</span>
            </div>
            <div className="space-y-1">
              {sectionItems.map((item) => (
                <ConversationRow
                  key={`${item.project.projectId}-${item.session.id}`}
                  item={item}
                  isSelected={selectedSession?.id === item.session.id}
                  currentTime={currentTime}
                  onSelect={onSelect}
                  editingSession={editingSession}
                  editingSessionName={editingSessionName}
                  onEditingSessionNameChange={onEditingSessionNameChange}
                  onStartEditingSession={onStartEditingSession}
                  onCancelEditingSession={onCancelEditingSession}
                  onSaveEditingSession={onSaveEditingSession}
                  onDeleteSession={onDeleteSession}
                  onArchiveSession={onArchiveSession}
                  t={t}
                />
              ))}
            </div>
          </div>
        );
      })}
      {hiddenCliCount > 0 && (
        <HiddenCliChatsRow count={hiddenCliCount} onShow={handleShowCliChats} t={t} />
      )}
    </div>
  );
}
