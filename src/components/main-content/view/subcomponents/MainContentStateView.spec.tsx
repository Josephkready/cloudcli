import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { Project, ProjectSession } from '../../../../types/app';

import MainContentStateView from './MainContentStateView';

/*
 * Empty-state onboarding copy (#241). The desktop tip used to tell people to
 * click "the folder icon in the sidebar" — the desktop sidebar header only has
 * Refresh / Plus / Hide, so that affordance never existed. The copy has to name
 * a control the user can actually find.
 */

describe('MainContentStateView — empty-state tip (#241)', () => {
  it('points desktop users at the + create control, not a non-existent folder icon', () => {
    render(<MainContentStateView mode="empty" isMobile={false} onMenuClick={vi.fn()} />);

    // `Tip:` lives in a nested <strong>; the advice is on the surrounding <p>.
    const tip = screen.getByText(/Tip:/).parentElement?.textContent ?? '';

    expect(tip).not.toMatch(/folder icon/i);
    // The desktop sidebar header renders a Plus button titled "Create new project".
    expect(tip).toMatch(/\+/);
    expect(tip).toMatch(/sidebar/i);
  });

  it('keeps the mobile tip pointing at the menu button', () => {
    render(<MainContentStateView mode="empty" isMobile onMenuClick={vi.fn()} />);

    // `Tip:` lives in a nested <strong>; the advice is on the surrounding <p>.
    const tip = screen.getByText(/Tip:/).parentElement?.textContent ?? '';

    expect(tip).not.toMatch(/folder icon/i);
    expect(tip).toMatch(/menu button/i);
  });
});


/*
 * #326: on mobile the empty state was a dead end — it said "select a project
 * from the sidebar", but on mobile there IS no visible sidebar, so opening the
 * app with nothing selected offered nothing to act on.
 *
 * What the user actually wants to resume is a CONVERSATION, not a project, so
 * the landing surface is the conversation list. It reuses the sidebar's own
 * `buildConversationList`, which means the ordering (Plan > Blocked > Done >
 * Running > Recent, newest first within a band) and the CLI-origin filtering
 * are the same here as in the sidebar rather than a second implementation that
 * can drift.
 *
 * Desktop is deliberately unchanged: the sidebar is already on screen there.
 */

const session = (over: Partial<ProjectSession> = {}): ProjectSession => ({
  id: 's1',
  summary: 'Fix the login bug',
  lastActivity: '2026-08-11T12:00:00.000Z',
  ...over,
} as ProjectSession);

const project = (over: Partial<Project> = {}): Project => ({
  projectId: 'p1',
  displayName: 'mind',
  path: '/home/jkready/repos/mind',
  fullPath: '/home/jkready/repos/mind',
  sessions: [],
  ...over,
} as Project);

const noActivity = new Map() as SessionActivityMap;

const conversationProps = (over: Record<string, unknown> = {}) => ({
  mode: 'empty' as const,
  isMobile: true,
  onMenuClick: vi.fn(),
  activeSessions: noActivity,
  onProjectSelect: vi.fn(),
  onSessionSelect: vi.fn(),
  ...over,
});

describe('MainContentStateView — mobile conversation picker (#326)', () => {
  const projects = [
    project({
      projectId: 'p1',
      displayName: 'mind',
      sessions: [
        session({ id: 's1', summary: 'Fix the login bug', lastActivity: '2026-08-11T12:00:00.000Z' }),
      ],
    }),
    project({
      projectId: 'p2',
      displayName: 'cloudcli',
      path: '/home/jkready/repos/cloudcli',
      sessions: [
        session({ id: 's2', summary: 'Ship the mobile picker', lastActivity: '2026-08-11T13:00:00.000Z' }),
      ],
    }),
  ];

  it('lists the conversations, not the projects', () => {
    render(<MainContentStateView {...conversationProps({ projects })} />);

    const rows = screen.getAllByTestId('mobile-conversation-option');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Fix the login bug')).toBeTruthy();
    expect(screen.getByText('Ship the mobile picker')).toBeTruthy();
  });

  it('shows which project each conversation belongs to', () => {
    // Without this the list is ambiguous the moment two projects have
    // similarly-named conversations.
    render(<MainContentStateView {...conversationProps({ projects })} />);

    const row = screen.getByText('Fix the login bug').closest('[data-testid="mobile-conversation-option"]');
    expect(row?.textContent).toMatch(/mind/);
  });

  it('opens the conversation AND its project when tapped', async () => {
    // Selecting only the session would leave the app with no project context —
    // the sidebar sets both, and so must this.
    const onProjectSelect = vi.fn();
    const onSessionSelect = vi.fn();
    render(<MainContentStateView {...conversationProps({ projects, onProjectSelect, onSessionSelect })} />);

    await userEvent.click(screen.getByText('Ship the mobile picker'));

    expect(onProjectSelect).toHaveBeenCalledWith(projects[1]);
    expect(onSessionSelect).toHaveBeenCalledTimes(1);
    const selected = onSessionSelect.mock.calls[0][0];
    expect(selected.id).toBe('s2');
    // Tagged so downstream handlers can correlate it with the selected project,
    // exactly as the sidebar does.
    expect(selected.__projectId).toBe('p2');
  });

  it('ranks a finished-but-unseen conversation above a merely recent one', () => {
    // The sidebar's ordering is "what needs me now", not raw recency: a Done
    // conversation outranks a newer Recent one.
    const ranked = [
      project({
        projectId: 'p1',
        displayName: 'mind',
        sessions: [
          session({ id: 'recent', summary: 'Just chatting', lastActivity: '2026-08-11T18:00:00.000Z' }),
          session({
            id: 'done',
            summary: 'Finished work',
            lastActivity: '2026-08-11T09:00:00.000Z',
            last_completed_at: '2026-08-11T09:00:00.000Z',
            last_viewed_at: null,
          }),
        ],
      }),
    ];
    render(<MainContentStateView {...conversationProps({ projects: ranked })} />);

    const texts = screen.getAllByTestId('mobile-conversation-option').map((n) => n.textContent ?? '');
    expect(texts[0]).toMatch(/Finished work/);
    expect(texts[1]).toMatch(/Just chatting/);
  });

  it('hides CLI-origin conversations, matching the sidebar', () => {
    const withCli = [
      project({
        projectId: 'p1',
        displayName: 'mind',
        sessions: [
          session({ id: 'app', summary: 'From the app' }),
          session({ id: 'cli', summary: 'From a terminal', origin: 'cli' }),
        ],
      }),
    ];
    render(<MainContentStateView {...conversationProps({ projects: withCli })} />);

    expect(screen.getAllByTestId('mobile-conversation-option')).toHaveLength(1);
    expect(screen.queryByText('From a terminal')).toBeNull();
  });

  it('falls back to the project list when there are no conversations yet', () => {
    // A first-run user has projects but nothing to resume, and an empty list
    // would be the same dead end this issue is about — so offer the thing that
    // lets them start one.
    const empty = [project({ projectId: 'p1', displayName: 'mind', sessions: [] })];
    render(<MainContentStateView {...conversationProps({ projects: empty })} />);

    expect(screen.queryAllByTestId('mobile-conversation-option')).toHaveLength(0);
    expect(screen.getAllByTestId('mobile-project-option')).toHaveLength(1);
  });

  it('does not duplicate the sidebar on desktop, where it is already visible', () => {
    render(<MainContentStateView {...conversationProps({ projects, isMobile: false })} />);

    expect(screen.queryAllByTestId('mobile-conversation-option')).toHaveLength(0);
    expect(screen.queryAllByTestId('mobile-project-option')).toHaveLength(0);
  });

  it('offers nothing while projects are still loading', () => {
    render(<MainContentStateView {...conversationProps({ projects, mode: 'loading' })} />);

    expect(screen.queryAllByTestId('mobile-conversation-option')).toHaveLength(0);
  });

  it('keeps the menu button, so the full sidebar stays reachable', () => {
    render(<MainContentStateView {...conversationProps({ projects })} />);

    expect(screen.getByLabelText(/menu/i)).toBeTruthy();
  });
});
