import React from 'react';

import ChatInterface from '../../chat/view/ChatInterface';
import type { MainContentProps } from '../types/types';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import { useStickyMount } from '../hooks/useStickyMount';
import LazySurface, { lazySurface } from '../../lazy/LazySurface';
import SurfaceSkeleton from '../../lazy/SurfaceSkeleton';
import { loadEditorSidebar, loadStandaloneShell } from '../../lazy/surfaceLoaders';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

// Chat is the tab the app opens on, so it stays in the entry chunk. Every other
// tab — and the editor side panel — is demand-loaded (issue #267): shipping
// xterm (~390 KB) and CodeMirror (~660 KB) to a session that only ever reads
// chat was the single largest main-thread task on a cold mobile load.
const FileTree = lazySurface(() => import('../../file-tree/view/FileTree'));
const StandaloneShell = lazySurface(loadStandaloneShell);
const GitPanel = lazySurface(() => import('../../git-panel/view/GitPanel'));
const PluginTabContent = lazySurface(() => import('../../plugins/view/PluginTabContent'));
const EditorSidebar = lazySurface(loadEditorSidebar);

function MainContent({
  selectedProject,
  selectedSession,
  onRenameSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onSessionSelect,
  onNewSession,
  onArchiveSession,
  projects,
  onProjectSelect,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  const isShellTab = activeTab === 'shell';
  const isShellMounted = useStickyMount(
    isShellTab,
    selectedProject?.fullPath || selectedProject?.path || null,
  );

  usePaletteOpsRegister({
    openFile: (filePath: string) => {
      setActiveTab('files');
      handleFileOpen(filePath);
    },
    // Opens the editor side panel in place, keeping the current tab (e.g. chat).
    openFileInEditor: (filePath: string) => {
      resolvedFileOpen(filePath);
    },
  });

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return (
      <MainContentStateView
        mode="empty"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        projects={projects}
        activeSessions={processingSessions}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        processingSessions={processingSessions}
        onSessionSelect={onSessionSelect}
        onNewSession={onNewSession}
        onRenameSession={onRenameSession}
        onArchiveSession={onArchiveSession}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionProcessing={onSessionProcessing}
                onSessionIdle={onSessionIdle}
                processingSessions={processingSessions}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                sendByCtrlEnter={sendByCtrlEnter}
                isMobile={isMobile}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
              />
            </ErrorBoundary>
          </div>

          {activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <LazySurface>
                <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} />
              </LazySurface>
            </div>
          )}

          {/*
            Hidden rather than unmounted once opened (issue #272): rebuilding
            xterm, its addons, a WebGL context and the pty websocket on every
            return made repeat opens as expensive as the first. The mount is
            scoped to the selected project, so at most one terminal is ever
            alive and it never outlives the project it belongs to. `autoConnect`
            follows the tab so a hidden shell never spawns a pty on its own.
          */}
          {isShellMounted && (
            <div className={`h-full w-full overflow-hidden ${isShellTab ? 'block' : 'hidden'}`}>
              <LazySurface>
                <StandaloneShell
                  project={selectedProject}
                  session={selectedSession}
                  showHeader={false}
                  isActive={isShellTab}
                  autoConnect={isShellTab}
                />
              </LazySurface>
            </div>
          )}

          {activeTab === 'git' && (
            <div className="h-full overflow-hidden">
              <LazySurface>
                <GitPanel selectedProject={selectedProject} isMobile={isMobile} onFileOpen={handleFileOpen} />
              </LazySurface>
            </div>
          )}

          {activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <LazySurface>
                <PluginTabContent
                  pluginName={activeTab.replace('plugin:', '')}
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                />
              </LazySurface>
            </div>
          )}
        </div>

        {/*
          Gated on `editingFile` rather than rendered unconditionally: the
          component already returns null without a file, but mounting a lazy
          component is what triggers its import, so the guard is what keeps
          CodeMirror off the boot path.
        */}
        {editingFile && (
          <LazySurface
            fallback={
              isMobile ? (
                <SurfaceSkeleton overlay label="Loading editor…" />
              ) : (
                <div
                  className="h-full flex-shrink-0 border-l border-border"
                  style={editorExpanded ? { flex: 1 } : { width: `${editorWidth}px` }}
                >
                  <SurfaceSkeleton label="Loading editor…" />
                </div>
              )
            }
          >
            <EditorSidebar
              editingFile={editingFile}
              isMobile={isMobile}
              editorExpanded={editorExpanded}
              editorWidth={editorWidth}
              hasManualWidth={hasManualWidth}
              resizeHandleRef={resizeHandleRef}
              onResizeStart={handleResizeStart}
              onCloseEditor={handleCloseEditor}
              onToggleEditorExpand={handleToggleEditorExpand}
              projectPath={selectedProject.path}
              fillSpace={activeTab === 'files'}
            />
          </LazySurface>
        )}
      </div>
    </div>
  );
}

export default React.memo(MainContent);
