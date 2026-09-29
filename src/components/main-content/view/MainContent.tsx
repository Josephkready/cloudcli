import React from 'react';

import ChatInterface from '../../chat/view/ChatInterface';
import type { MainContentProps } from '../types/types';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import LazySurface, { lazySurface } from '../../lazy/LazySurface';
import SurfaceSkeleton from '../../lazy/SurfaceSkeleton';
import { loadEditorSidebar } from '../../lazy/surfaceLoaders';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

// Chat is the tab the app opens on, so it stays in the entry chunk. The editor
// side panel is demand-loaded (issue #267): shipping CodeMirror (~660 KB) to a
// session that only ever reads chat was the single largest main-thread task on
// a cold mobile load.
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

  usePaletteOpsRegister({
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
        onNewConversation={onNewSession}
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
        </div>

        {/*
          Gated on `editingFile` rather than rendered unconditionally: the
          component already returns null without a file, but mounting a lazy
          component is what triggers its import, so the guard is what keeps
          CodeMirror off the boot path.
        */}
        {editingFile && (
          // data-vd-mask: file names/paths are never captured as locator names.
          // `contents` keeps this wrapper out of the flex layout.
          <div data-vd-mask="" className="contents">
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
              resizeHandleRef={resizeHandleRef}
              onResizeStart={handleResizeStart}
              onCloseEditor={handleCloseEditor}
              onToggleEditorExpand={handleToggleEditorExpand}
              projectPath={selectedProject.path}
            />
          </LazySurface>
          </div>
        )}
      </div>
    </div>
  );
}

export default React.memo(MainContent);
