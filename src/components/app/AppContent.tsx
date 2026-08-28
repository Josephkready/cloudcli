import { useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import CommandPaletteHost from '../command-palette/CommandPaletteHost';
import { WARMABLE_SURFACES } from '../lazy/surfaceLoaders';
import { useWarmLazySurfaces } from '../lazy/useWarmLazySurfaces';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useQueuedMessageAutoSend } from '../../hooks/useQueuedMessageAutoSend';
import { useRunningSessionsPoll } from '../../hooks/useRunningSessionsPoll';
import { useArchiveSession } from '../../hooks/useArchiveSession';
import { api } from '../../utils/api';
import { useLaunchIntent } from '../../pwa/useLaunchIntent';

import {
  installKeyboardViewportSync,
  keyboardAwareBottomStyle,
  viewportShellStyle,
} from './keyboardViewport';

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe, isConnected } = useWebSocket();

  // Shell and the code editor moved out of the entry chunk (#267); pull them
  // back in once the page is idle so the first click on either is still instant.
  useWarmLazySurfaces(WARMABLE_SURFACES);

  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
  } = useSessionProtection();

  const {
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    openSettings,
    refreshProjectsSilently,
    registerOptimisticSession,
    sidebarSharedProps,
    handleNewSession,
    handleSessionSelect,
  } = useProjectsState({
    sessionId,
    navigate,
    subscribe,
    isMobile,
    activeSessions: processingSessions,
  });

  // Home-screen shortcut ("New conversation") and shared text arriving from
  // another app both come in as launch parameters (#370). `null` until a project
  // is available, so a cold launch holds the shortcut rather than dropping it.
  useLaunchIntent(
    selectedProject ? () => handleNewSession(selectedProject) : null,
  );

  // Soft-archive from the chat view's header. Reuses the same handler the
  // sidebar rows use; `onSessionDelete` drops the session from the tree and
  // deselects it, so the view falls back to the empty state.
  const archiveSession = useArchiveSession({
    t,
    onSessionDelete: sidebarSharedProps.onSessionDelete,
  });

  // Queued messages for sessions that finish while another session (or none)
  // is being viewed are sent from here; the viewed session's composer handles
  // its own queue.
  useQueuedMessageAutoSend({
    processingSessions,
    activeSessionId: selectedSession?.id ?? sessionId ?? null,
    ws,
    sendMessage,
    markSessionProcessing,
  });

  // Global "which sessions are running" state. The hook explains why a poll is
  // still needed alongside the websocket, and gates it on tab visibility (#273).
  useRunningSessionsPoll({
    syncProcessingSessions,
    hasRunningSessions: processingSessions.size > 0,
    isConnected,
  });

  // Rename from the chat header — persists the new summary then refreshes so the
  // header and the sidebar rows both reflect it. Mirrors the sidebar rename path.
  const handleRenameSession = useCallback(
    async (targetSessionId: string, summary: string) => {
      try {
        // `authenticatedFetch` resolves (never throws) on non-2xx, so an HTTP
        // failure must be checked explicitly — otherwise a failed rename would
        // be treated as success and refresh anyway.
        const response = await api.renameSession(targetSessionId, summary);
        if (!response.ok) {
          console.error('[AppContent] Failed to rename session:', response.status);
          return;
        }
        await refreshProjectsSilently();
      } catch (error) {
        console.error('[AppContent] Failed to rename session:', error);
      }
    },
    [refreshProjectsSilently],
  );

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        localStorage.setItem('selected-provider', message.provider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  // Pending tool permissions are recovered through the `chat.subscribe` flow:
  // the `chat_subscribed` ack carries them on session open and on reconnect,
  // so no separate permission-recovery message is needed here.

  // Keep the fixed app shell aligned with the visible area while the iOS soft
  // keyboard is up: publish the keyboard height for the shell's bottom edge,
  // and undo the viewport displacement WebKit applies when it scrolls a focused
  // field into view (#334). Both rules live in ./keyboardViewport so they can be
  // tested against a fake viewport.
  useEffect(() => installKeyboardViewportSync(window, document), []);

  return (
    // `viewportShellStyle`, not `inset-0`: the shell is the element
    // `--keyboard-height` is computed for, and that number counts from the layout
    // viewport's origin. `body.pwa-mode .fixed.inset-0` would move this box down
    // by the header safe area in the installed PWA — and only there — leaving the
    // shell driven by a measurement from a coordinate space it no longer occupies.
    // `.pwa-shell-safe` keeps the safe-area clearance as padding instead.
    <div className="pwa-shell-safe fixed flex bg-background" style={viewportShellStyle()}>
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Sidebar {...sidebarSharedProps} />
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-[opacity,visibility] duration-base ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
          // Its own offset, not the shell's: this overlay is `position: fixed`,
          // so it resolves against the viewport and inherits nothing from the
          // raised edge above it. Without this the new-conversation folder
          // search sat behind the keyboard (#346).
          style={keyboardAwareBottomStyle()}
        >
          <button
            className="fixed inset-0 bg-background/80 transition-opacity duration-base ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform border-r border-border/40 bg-card transition-transform duration-base ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar {...sidebarSharedProps} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <MainContent
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          onRenameSession={handleRenameSession}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={sendMessage}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionProcessing={markSessionProcessing}
          onSessionIdle={markSessionIdle}
          processingSessions={processingSessions}
          onNavigateToSession={(targetSessionId: string, options) =>
            navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) })
          }
          onSessionEstablished={(targetSessionId, context) =>
            registerOptimisticSession({ sessionId: targetSessionId, ...context })
          }
          onShowSettings={openSettings}
          externalMessageUpdate={externalMessageUpdate}
          newSessionTrigger={newSessionTrigger}
          onSessionSelect={handleSessionSelect}
          onNewSession={handleNewSession}
          onArchiveSession={archiveSession}
          // Same list and handler the sidebar uses, so the mobile landing
          // picker cannot drift from the sidebar's ordering (#326).
          projects={sidebarSharedProps.projects}
          onProjectSelect={sidebarSharedProps.onProjectSelect}
        />
      </div>

      <CommandPaletteHost
        selectedProject={selectedProject}
        onStartNewChat={handleNewSession}
        onOpenSettings={() => openSettings()}
        onShowTab={setActiveTab}
      />
    </div>
  );
}
