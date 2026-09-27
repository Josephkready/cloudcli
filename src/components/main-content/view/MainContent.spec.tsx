import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../../../types/app';
import type { MainContentProps } from '../types/types';

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

describe('MainContent — the other tabs stay cheap', () => {
  it('unmounts the files surface on tab-away', async () => {
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

    rerender(<MainContent {...baseProps({ activeTab: 'git' })} />);
    await screen.findByTestId('git-panel');

    expect(screen.getByTestId('chat-interface').parentElement).toHaveClass('hidden');
  });
});

describe('MainContent — state views', () => {
  it('renders the loading view instead of any surface while loading', () => {
    render(<MainContent {...baseProps({ isLoading: true, activeTab: 'chat' })} />);

    expect(screen.queryByTestId('chat-interface')).toBeNull();
  });

  it('renders the empty view when no project is selected', () => {
    render(<MainContent {...baseProps({ selectedProject: null, activeTab: 'chat' })} />);

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


/*
 * #331: the landing page could resume a conversation but not start one.
 * MainContent is what hands the empty state its handlers, so a button wired to
 * nothing here is a button that does nothing on screen — the same class of gap
 * as #326 itself. `onNewSession` is the handler the sidebar's own "New
 * conversation" button uses, so both surfaces start a chat the same way.
 */
describe('MainContent — mobile landing new conversation (#331)', () => {
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

  it('gives the landing page a working way to start a conversation', async () => {
    const onNewSession = vi.fn();
    render(<MainContent {...landingProps({ onNewSession })} />);

    await userEvent.click(screen.getByRole('button', { name: /new conversation/i }));
    const option = screen
      .getAllByRole('option')
      .find((node) => /beta/.test(node.textContent ?? ''));
    await userEvent.click(option as HTMLElement);

    expect(onNewSession).toHaveBeenCalledWith(withSessions[1]);
  });

  it('does not put the button on the desktop empty state', () => {
    render(<MainContent {...landingProps({ isMobile: false })} />);

    expect(screen.queryByRole('button', { name: /new conversation/i })).toBeNull();
  });
});
