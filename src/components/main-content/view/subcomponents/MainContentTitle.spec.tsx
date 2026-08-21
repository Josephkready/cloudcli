import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MainContentTitle from './MainContentTitle';

import type { Project, ProjectSession } from '@/types/app';

/*
 * #364: on mobile the open-session strip directly below the header already shows
 * the session title at nearly full width, so the header must not repeat it (there
 * it truncates to a couple of words). On mobile the header collapses to the
 * project name; desktop keeps the editable session title.
 */

vi.mock('@/contexts/PluginsContext', () => ({
  usePlugins: () => ({ plugins: [], loading: false, pluginsError: null, refreshPlugins: () => {} }),
}));

const project = {
  projectId: 'p1',
  projectPath: '/repos/p1',
  displayName: 'demo-project',
  fullPath: '/repos/p1',
  sessions: [],
} as unknown as Project;

const LONG_TITLE = 'Show me a long code sample and a very long single-token string please';

const session = {
  id: 's1',
  summary: LONG_TITLE,
  __provider: 'claude',
  lastActivity: '2026-08-21T00:00:00Z',
} as unknown as ProjectSession;

function renderTitle(isMobile: boolean) {
  render(
    <MainContentTitle
      activeTab="chat"
      selectedProject={project}
      selectedSession={session}
      onRenameSession={vi.fn()}
      isMobile={isMobile}
    />,
  );
}

describe('MainContentTitle — mobile title de-duplication (#364)', () => {
  it('desktop shows the editable session title', () => {
    renderTitle(false);
    expect(screen.getByRole('button', { name: new RegExp(LONG_TITLE) })).toBeTruthy();
    // Project name is present as the subtitle.
    expect(screen.getByText('demo-project')).toBeTruthy();
  });

  it('mobile collapses the header to the project name and drops the session title', () => {
    renderTitle(true);
    expect(screen.getByText('demo-project')).toBeTruthy();
    // The session title must not appear in the header on mobile — the strip below owns it.
    expect(screen.queryByText(new RegExp(LONG_TITLE))).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(LONG_TITLE) })).toBeNull();
  });
});
