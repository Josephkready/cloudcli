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
  sendMessage: (message: unknown) => void;
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
};

export type MobileMenuButtonProps = {
  onMenuClick: () => void;
  compact?: boolean;
};
