import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WP4 #2 (E.report.md finding 2): MainContent is React.memo'd, but AppContentInner
// used to pass it brand-new `onMenuClick`/`onNavigateToSession`/`onSessionEstablished`
// closures on every render, defeating the memo unconditionally. This spec renders the
// real AppContent + AppContentInner with everything else mocked, forces a re-render,
// and asserts (a) the callback prop identities MainContent receives stay stable and
// (b) MainContent itself does not re-render as a result.

let mainContentRenderCount = 0;
let lastMainContentProps: Record<string, unknown> | null = null;

vi.mock('../main-content/view/MainContent', () => ({
  default: React.memo(function MainContentStub(props: Record<string, unknown>) {
    mainContentRenderCount += 1;
    lastMainContentProps = props;
    return <div data-testid="main-content" />;
  }),
}));

vi.mock('../sidebar/view/Sidebar', () => ({
  default: () => <div data-testid="sidebar" />,
}));

vi.mock('../lazy/useWarmLazySurfaces', () => ({
  useWarmLazySurfaces: () => {},
}));

vi.mock('../lazy/surfaceLoaders', () => ({
  WARMABLE_SURFACES: [],
}));

const webSocketValue = {
  ws: null,
  sendMessage: vi.fn(),
  subscribe: () => () => {},
  isConnected: true,
};
vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocket: () => webSocketValue,
}));

vi.mock('../../contexts/PaletteOpsContext', () => ({
  PaletteOpsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePaletteOpsRegister: () => {},
}));

const deviceSettingsValue = { isMobile: false };
vi.mock('../../hooks/useDeviceSettings', () => ({
  useDeviceSettings: () => deviceSettingsValue,
}));

const sessionProtectionValue = {
  processingSessions: new Map(),
  markSessionProcessing: vi.fn(),
  markSessionIdle: vi.fn(),
  syncProcessingSessions: vi.fn(),
};
vi.mock('../../hooks/useSessionProtection', () => ({
  useSessionProtection: () => sessionProtectionValue,
}));

const projectsStateValue = {
  selectedProject: null,
  selectedSession: null,
  activeTab: 'chat',
  sidebarOpen: false,
  isLoadingProjects: false,
  externalMessageUpdate: null,
  newSessionTrigger: 0,
  setActiveTab: vi.fn(),
  setSidebarOpen: vi.fn(),
  setIsInputFocused: vi.fn(),
  openSettings: vi.fn(),
  refreshProjectsSilently: vi.fn(async () => {}),
  registerOptimisticSession: vi.fn(),
  sidebarSharedProps: { projects: [], onProjectSelect: vi.fn(), onSessionDelete: vi.fn() },
  handleNewSession: vi.fn(),
  handleSessionSelect: vi.fn(),
};
vi.mock('../../hooks/useProjectsState', () => ({
  useProjectsState: () => projectsStateValue,
}));

vi.mock('../../hooks/useQueuedMessageAutoSend', () => ({
  useQueuedMessageAutoSend: () => {},
}));

vi.mock('../../hooks/useRunningSessionsPoll', () => ({
  useRunningSessionsPoll: () => {},
}));

const archiveSessionMock = vi.fn();
vi.mock('../../hooks/useArchiveSession', () => ({
  useArchiveSession: () => archiveSessionMock,
}));

let versionCheckValue = { newBuildAvailable: false, checkNow: vi.fn() };
vi.mock('../../hooks/useVersionCheck', () => ({
  VersionCheckProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useVersionCheck: () => versionCheckValue,
}));

vi.mock('../../pwa/useLaunchIntent', () => ({
  useLaunchIntent: () => {},
}));

vi.mock('../../utils/api', () => ({
  api: { renameSession: vi.fn() },
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({}),
}));

const { default: AppContent } = await import('./AppContent');

describe('AppContentInner -> MainContent memo stability (WP4 #2)', () => {
  beforeEach(() => {
    mainContentRenderCount = 0;
    lastMainContentProps = null;
    versionCheckValue = { newBuildAvailable: false, checkNow: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps onMenuClick/onNavigateToSession/onSessionEstablished referentially stable across re-renders', () => {
    const { rerender } = render(<AppContent />);

    expect(mainContentRenderCount).toBe(1);
    const firstProps = lastMainContentProps as Record<string, unknown>;
    const firstOnMenuClick = firstProps.onMenuClick;
    const firstOnNavigateToSession = firstProps.onNavigateToSession;
    const firstOnSessionEstablished = firstProps.onSessionEstablished;

    // Force AppContentInner to re-run its render body (e.g. an unrelated
    // build-available flip), without changing anything MainContent reads.
    act(() => {
      versionCheckValue = { newBuildAvailable: true, checkNow: versionCheckValue.checkNow };
      rerender(<AppContent />);
    });

    const secondProps = lastMainContentProps as Record<string, unknown>;
    expect(secondProps.onMenuClick).toBe(firstOnMenuClick);
    expect(secondProps.onNavigateToSession).toBe(firstOnNavigateToSession);
    expect(secondProps.onSessionEstablished).toBe(firstOnSessionEstablished);

    // React.memo's shallow comparison should therefore skip re-rendering
    // MainContent entirely -- the render count stays at 1.
    expect(mainContentRenderCount).toBe(1);
  });
});
