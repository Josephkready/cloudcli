import type { Dispatch, SetStateAction } from 'react';

import type { AppTab, Project, ProjectSession } from '../../../types/app';
import type {
  MarkSessionIdle,
  MarkSessionProcessing,
  SessionActivityMap,
} from '../../../hooks/useSessionProtection';
import type { SessionEstablishedContext, SessionNavigationOptions } from '../../chat/types/types';
import type { SettingsMainTab } from '../../settings/types/types';

export type MainContentProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  onRenameSession: (sessionId: string, summary: string) => void | Promise<void>;
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onInputFocusChange: (focused: boolean) => void;
  onSessionProcessing: MarkSessionProcessing;
  onSessionIdle: MarkSessionIdle;
  processingSessions: SessionActivityMap;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  // Switch to a session in the active space (the per-space session tab bar).
  onSessionSelect: (session: ProjectSession) => void;
  // Start a fresh session in the given space (the tab bar's ＋ affordance).
  onNewSession: (project: Project) => void;
  // Soft-archive the active session from the chat view's header.
  onArchiveSession: (sessionId: string) => void | Promise<void>;
  /**
   * The sidebar's project list, forwarded to the mobile empty state so the
   * landing page can offer a choice instead of pointing at a sidebar that is
   * hidden behind the burger menu (#326).
   */
  projects?: Project[];
  onProjectSelect?: (project: Project) => void;
};

export type MainContentHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  isMobile: boolean;
  onMenuClick: () => void;
  processingSessions: SessionActivityMap;
  onSessionSelect: (session: ProjectSession) => void;
  onNewSession: (project: Project) => void;
  onRenameSession: (sessionId: string, summary: string) => void | Promise<void>;
  onArchiveSession: (sessionId: string) => void | Promise<void>;
};

export type MainContentStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
  /**
   * Source data for the mobile landing picker (#326). The conversation list is
   * derived from these with the sidebar's own `buildConversationList`, so the
   * two cannot drift. Optional so the view still renders standalone — without
   * them it falls back to the onboarding copy.
   */
  projects?: Project[];
  activeSessions?: SessionActivityMap;
  onProjectSelect?: (project: Project) => void;
  onSessionSelect?: (session: ProjectSession) => void;
  /**
   * Starts a fresh conversation in the chosen project (#331). The landing page
   * let you resume a conversation but never begin one, which left a first
   * action with no control behind it. Wired to the same `onNewSession` the
   * sidebar's "New conversation" button uses.
   */
  onNewConversation?: (project: Project) => void;
};

export type MobileMenuButtonProps = {
  onMenuClick: () => void;
  compact?: boolean;
};
