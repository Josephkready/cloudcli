import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import MainContentHeader from './MainContentHeader';

import type { Project, ProjectSession } from '@/types/app';

/*
 * Chat-view archive button (#215). The header owns a one-click soft-archive for
 * the open conversation: it shows only when a session is selected and it hands
 * that session's id to the shared archive handler with no confirmation step.
 */

vi.mock('@/contexts/PluginsContext', () => ({
  usePlugins: () => ({ plugins: [], loading: false, pluginsError: null, refreshPlugins: () => {} }),
}));

const project = {
  projectId: 'p1',
  projectPath: '/repos/p1',
  displayName: 'p1',
  fullPath: '/repos/p1',
  sessions: [],
} as unknown as Project;

const session = {
  id: 's1',
  summary: 'hello world',
  lastActivity: '2026-07-22T00:00:00Z',
} as unknown as ProjectSession;

function renderHeader(
  selectedSession: ProjectSession | null,
  onArchiveSession = vi.fn(),
  isMobile = false,
) {
  render(
    <MainContentHeader
      activeTab="chat"
      setActiveTab={vi.fn()}
      selectedProject={project}
      selectedSession={selectedSession}
      isMobile={isMobile}
      onMenuClick={vi.fn()}
      processingSessions={new Map()}
      onSessionSelect={vi.fn()}
      onNewSession={vi.fn()}
      onRenameSession={vi.fn()}
      onArchiveSession={onArchiveSession}
    />,
  );

  return onArchiveSession;
}

describe('MainContentHeader — archive action (#215)', () => {
  it('archives the open session on a single click, with no confirmation', async () => {
    const onArchiveSession = renderHeader(session);

    const button = screen.getByRole('button', { name: 'Archive conversation' });
    await userEvent.click(button);

    expect(onArchiveSession).toHaveBeenCalledTimes(1);
    expect(onArchiveSession).toHaveBeenCalledWith('s1');
    // A soft archive is recoverable, so nothing modal should have appeared.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides the archive action when no conversation is open', () => {
    renderHeader(null);

    expect(screen.queryByRole('button', { name: 'Archive conversation' })).toBeNull();
  });
});

/*
 * #363: the header icon buttons are 28-32px, below the repo's 44px touch floor.
 * They floor the touch height with `touch:hit-h-44` (height-only, since they sit
 * in a gap-1 row where a 44px-wide overlay would steal taps from a neighbour).
 */
describe('MainContentHeader — touch targets (#363)', () => {
  it('floors the header icon buttons at the 44px touch height', () => {
    renderHeader(session, vi.fn(), true);

    for (const name of ['Report a bug', 'Archive conversation', 'Open menu']) {
      const button = screen.getByRole('button', { name });
      expect(button.className, `"${name}" must floor its touch height`).toContain('touch:hit-h-44');
    }
  });
});

/*
 * #225: the opened-session header must surface the CLI origin. A session cloudcli
 * isn't driving (origin === 'cli') gets the same hedged badge/tooltip the sidebar
 * Conversations list uses; a cloudcli-driven (or origin-less) session stays clean,
 * so the two are no longer indistinguishable once opened.
 */
const cliSession = {
  id: 's1',
  summary: 'hello world',
  origin: 'cli',
  lastActivity: '2026-07-22T00:00:00Z',
} as unknown as ProjectSession;

const cloudSession = {
  id: 's1',
  summary: 'hello world',
  origin: 'cloudcli',
  lastActivity: '2026-07-22T00:00:00Z',
} as unknown as ProjectSession;

/*
 * The bug reporter's own behavior is covered by BugReportDialog.spec.tsx; what
 * only the header can prove is that the button is actually wired to it — and
 * that it's reachable even with no conversation open, since a bug worth filing
 * often left the app in a state where nothing else works.
 */
describe('MainContentHeader — bug reporter', () => {
  it('opens the reporter dialog from the top panel', async () => {
    renderHeader(session);

    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Report a bug' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText('What happened?')).toBeInTheDocument();
  });

  it('offers the reporter even when no conversation is open', () => {
    renderHeader(null);

    expect(screen.getByRole('button', { name: 'Report a bug' })).toBeInTheDocument();
  });
});

describe('MainContentHeader — CLI-origin badge (#225)', () => {
  it('badges the open-session title when the session is terminal/CLI-driven', () => {
    renderHeader(cliSession);

    const badge = screen.getByLabelText('Session not driven by cloudcli');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('CLI');
    expect(badge).toHaveAttribute(
      'title',
      'Not driven by cloudcli — started from a terminal/CLI (or created before session tracking), so its live status is unknown',
    );
  });

  it('shows no CLI badge for a cloudcli-driven session', () => {
    renderHeader(cloudSession);

    expect(screen.queryByLabelText('Session not driven by cloudcli')).toBeNull();
  });

  it('shows no CLI badge when no conversation is open', () => {
    renderHeader(null);

    expect(screen.queryByLabelText('Session not driven by cloudcli')).toBeNull();
  });
});
