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

function renderHeader(selectedSession: ProjectSession | null, onArchiveSession = vi.fn()) {
  render(
    <MainContentHeader
      activeTab="chat"
      setActiveTab={vi.fn()}
      selectedProject={project}
      selectedSession={selectedSession}
      isMobile={false}
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
