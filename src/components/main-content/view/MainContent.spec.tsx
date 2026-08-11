import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../../../types/app';
import type { MainContentProps } from '../types/types';

/*
 * #292 made MainContent responsible for the shell surface's *mount lifetime*,
 * and #295 flagged that the file had no spec at all. What is load-bearing here
 * is not the tab switch — it is the three properties that keep exactly one pty
 * and one WebGL context alive:
 *
 *   - the shell is hidden, not unmounted, on tab-away (rebuilding xterm + the
 *     pty on every return is what #272 removed)
 *   - `autoConnect` is false while it is hidden, so a backgrounded shell never
 *     spawns a pty on its own
 *   - a project switch *drops* the surface, so a shell can never outlive the
 *     project it belongs to
 *
 * The lazy boundary is deliberately left real — hidden-vs-unmounted is a claim
 * about what LazySurface/useStickyMount actually put in the tree.
 */

const shellRenders = vi.hoisted(() => [] as Record<string, unknown>[]);
const shellMounts = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../standalone-shell/view/StandaloneShell', () => ({
  default: (props: Record<string, unknown>) => {
    shellRenders.push(props);
    return <div data-testid="standalone-shell" />;
  },
}));

vi.mock('../../chat/view/ChatInterface', () => ({
  default: () => <div data-testid="chat-interface" />,
}));

vi.mock('./subcomponents/MainContentHeader', () => ({
  default: () => <div data-testid="main-content-header" />,
}));

vi.mock('../../file-tree/view/FileTree', () => ({
  default: () => <div data-testid="file-tree" />,
}));

vi.mock('../../git-panel/view/GitPanel', () => ({
  default: () => <div data-testid="git-panel" />,
}));

vi.mock('../../plugins/view/PluginTabContent', () => ({
  default: () => <div data-testid="plugin-tab" />,
}));

vi.mock('../../code-editor/view/EditorSidebar', () => ({
  default: () => <div data-testid="editor-sidebar" />,
}));

const { default: MainContent } = await import('./MainContent');

const project = (path: string): Project => ({
  projectId: path,
  displayName: path.split('/').pop() ?? path,
  fullPath: path,
  path,
});

const baseProps = (overrides: Partial<MainContentProps> = {}): MainContentProps =>
  ({
    selectedProject: project('/home/dev/alpha'),
    selectedSession: null as ProjectSession | null,
    onRenameSession: vi.fn(),
    activeTab: 'chat',
    setActiveTab: vi.fn(),
    ws: null,
    sendMessage: vi.fn(),
    isMobile: false,
    onMenuClick: vi.fn(),
    isLoading: false,
    onInputFocusChange: vi.fn(),
    onSessionProcessing: vi.fn(),
    onSessionIdle: vi.fn(),
    processingSessions: {},
    onNavigateToSession: vi.fn(),
    onSessionEstablished: vi.fn(),
    onShowSettings: vi.fn(),
    externalMessageUpdate: 0,
    newSessionTrigger: 0,
    onSessionSelect: vi.fn(),
    onNewSession: vi.fn(),
    onArchiveSession: vi.fn(),
    ...overrides,
  }) as MainContentProps;

/**
 * The wrapper whose `hidden` class is what takes the surface off-screen.
 * Resolved by climbing to it rather than by a fixed number of parents, so an
 * extra wrapper inside the lazy boundary doesn't quietly turn this into an
 * assertion about some other element.
 */
const shellWrapper = () =>
  screen.getByTestId('standalone-shell').closest('div.h-full.w-full') as HTMLElement;

const lastShellProps = () => shellRenders[shellRenders.length - 1];

beforeEach(() => {
  shellRenders.length = 0;
  shellMounts.count = 0;
});

describe('MainContent — shell surface lifetime (#295)', () => {
  it('does not mount the shell until its tab is opened', () => {
    render(<MainContent {...baseProps({ activeTab: 'chat' })} />);

    // The chunk is not even requested: mounting the lazy component is what
    // triggers its import, which is the whole point of #267's split.
    expect(screen.queryByTestId('standalone-shell')).toBeNull();
  });

  it('hides the shell rather than unmounting it on tab-away', async () => {
    const { rerender } = render(<MainContent {...baseProps({ activeTab: 'shell' })} />);

    await screen.findByTestId('standalone-shell');
    expect(shellWrapper()).not.toHaveClass('hidden');

    rerender(<MainContent {...baseProps({ activeTab: 'chat' })} />);

    // Still in the tree — rebuilding xterm, its addons, a WebGL context and the
    // pty on every return is exactly what #272 removed.
    expect(screen.getByTestId('standalone-shell')).toBeInTheDocument();
    expect(shellWrapper()).toHaveClass('hidden');
  });

  it('drops autoConnect and isActive while the shell is hidden', async () => {
    const { rerender } = render(<MainContent {...baseProps({ activeTab: 'shell' })} />);

    await screen.findByTestId('standalone-shell');
    expect(lastShellProps()).toMatchObject({ autoConnect: true, isActive: true });

    rerender(<MainContent {...baseProps({ activeTab: 'chat' })} />);

    // A hidden shell must not spawn a pty on its own.
    expect(lastShellProps()).toMatchObject({ autoConnect: false, isActive: false });
  });

  it('drops the surface when the project changes, so a shell never outlives its project', async () => {
    const { rerender } = render(<MainContent {...baseProps({ activeTab: 'shell' })} />);
    await screen.findByTestId('standalone-shell');

    // Leave the tab first: the surface is now mounted-but-hidden, the state in
    // which it could quietly survive a project switch.
    rerender(<MainContent {...baseProps({ activeTab: 'chat' })} />);
    expect(screen.getByTestId('standalone-shell')).toBeInTheDocument();

    rerender(
      <MainContent {...baseProps({ activeTab: 'chat', selectedProject: project('/home/dev/beta') })} />,
    );

    await waitFor(() => expect(screen.queryByTestId('standalone-shell')).toBeNull());
  });

  it('rebuilds the surface against the new project when the shell is reopened', async () => {
    const { rerender } = render(<MainContent {...baseProps({ activeTab: 'shell' })} />);
    await screen.findByTestId('standalone-shell');

    rerender(
      <MainContent {...baseProps({ activeTab: 'shell', selectedProject: project('/home/dev/beta') })} />,
    );

    await waitFor(() =>
      expect(lastShellProps()).toMatchObject({
        autoConnect: true,
        project: expect.objectContaining({ fullPath: '/home/dev/beta' }),
      }),
    );
    // One surface at a time, never two live terminals.
    expect(screen.getAllByTestId('standalone-shell')).toHaveLength(1);
  });
});

describe('MainContent — the other tabs stay cheap', () => {
  it('unmounts the files and git surfaces on tab-away, unlike the shell', async () => {
    const { rerender } = render(<MainContent {...baseProps({ activeTab: 'files' })} />);
    await screen.findByTestId('file-tree');

    rerender(<MainContent {...baseProps({ activeTab: 'git' })} />);

    await screen.findByTestId('git-panel');
    expect(screen.queryByTestId('file-tree')).toBeNull();
  });

  it('keeps chat mounted but hidden while another tab is active', async () => {
    const { rerender } = render(<MainContent {...baseProps({ activeTab: 'chat' })} />);
    const chat = screen.getByTestId('chat-interface');
    expect(chat.parentElement).toHaveClass('block');

    rerender(<MainContent {...baseProps({ activeTab: 'shell' })} />);
    await screen.findByTestId('standalone-shell');

    expect(screen.getByTestId('chat-interface').parentElement).toHaveClass('hidden');
  });
});

describe('MainContent — state views', () => {
  it('renders the loading view instead of any surface while loading', () => {
    render(<MainContent {...baseProps({ isLoading: true, activeTab: 'shell' })} />);

    expect(screen.queryByTestId('standalone-shell')).toBeNull();
    expect(screen.queryByTestId('chat-interface')).toBeNull();
  });

  it('renders the empty view when no project is selected', () => {
    render(<MainContent {...baseProps({ selectedProject: null, activeTab: 'shell' })} />);

    expect(screen.queryByTestId('standalone-shell')).toBeNull();
    expect(screen.queryByTestId('chat-interface')).toBeNull();
  });
});


/*
 * #326: the mobile empty state is the app's landing page whenever no project is
 * selected. MainContent owns the decision to render that state, so it also has
 * to hand it the data — otherwise the view can offer a picker and never receive
 * anything to pick.
 */
describe('MainContent — mobile landing conversation picker (#326)', () => {
  const withSessions = [
    {
      ...project('/home/dev/alpha'),
      sessions: [{ id: 's1', summary: 'Alpha work', lastActivity: '2026-08-11T12:00:00.000Z' }],
    },
    {
      ...project('/home/dev/beta'),
      sessions: [{ id: 's2', summary: 'Beta work', lastActivity: '2026-08-11T13:00:00.000Z' }],
    },
  ] as Project[];

  const landingProps = (over: Partial<MainContentProps> = {}) => baseProps({
    selectedProject: null,
    isMobile: true,
    projects: withSessions,
    processingSessions: new Map(),
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    ...over,
  });

  it('gives the mobile empty state the conversations it needs to offer a choice', () => {
    render(<MainContent {...landingProps()} />);

    expect(screen.getAllByTestId('mobile-conversation-option')).toHaveLength(2);
  });

  it('a tap reaches both handlers MainContent was given', () => {
    const onProjectSelect = vi.fn();
    const onSessionSelect = vi.fn();
    render(<MainContent {...landingProps({ onProjectSelect, onSessionSelect })} />);

    screen.getByText('Beta work').click();

    expect(onProjectSelect).toHaveBeenCalledWith(withSessions[1]);
    expect(onSessionSelect.mock.calls[0][0].id).toBe('s2');
  });

  it('leaves the desktop empty state alone', () => {
    render(<MainContent {...landingProps({ isMobile: false })} />);

    expect(screen.queryAllByTestId('mobile-conversation-option')).toHaveLength(0);
  });

  it('offers nothing to pick while projects are still loading', () => {
    render(<MainContent {...landingProps({ isLoading: true })} />);

    expect(screen.queryAllByTestId('mobile-conversation-option')).toHaveLength(0);
  });
});
