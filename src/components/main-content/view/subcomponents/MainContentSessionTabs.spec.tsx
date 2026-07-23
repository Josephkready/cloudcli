import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Project, ProjectSession } from '../../../../types/app';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';

import MainContentSessionTabs from './MainContentSessionTabs';

/*
 * #217: on mobile the horizontal open-session pill strip collapses into a
 * hamburger button + overlay list. Desktop keeps the pill strip. These lock in
 * both presentations and the overlay's select/close behaviour.
 */

const project = {
  projectId: 'p1',
  displayName: 'p1',
  fullPath: '/repos/p1',
  sessions: [
    { id: 's1', summary: 'First chat', lastActivity: '2026-07-20T00:00:00Z', __provider: 'claude' },
    { id: 's2', summary: 'Second chat', lastActivity: '2026-07-21T00:00:00Z', __provider: 'claude' },
  ],
} as unknown as Project;

const selectedSession = { id: 's1', summary: 'First chat' } as unknown as ProjectSession;

function renderTabs(isMobile: boolean, overrides: Record<string, unknown> = {}) {
  const onSessionSelect = vi.fn();
  const onNewSession = vi.fn();
  const result = render(
    <MainContentSessionTabs
      selectedProject={project}
      selectedSession={selectedSession}
      processingSessions={new Map() as SessionActivityMap}
      isMobile={isMobile}
      onSessionSelect={onSessionSelect}
      onNewSession={onNewSession}
      {...overrides}
    />,
  );
  return { ...result, onSessionSelect, onNewSession };
}

describe('MainContentSessionTabs — mobile hamburger (#217)', () => {
  it('renders a single collapsed trigger with the active session and a count', () => {
    renderTabs(true);

    const trigger = screen.getByRole('button', { name: 'Open sessions menu' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('First chat');
    expect(trigger).toHaveTextContent('2');

    // The list itself is collapsed until the trigger is tapped.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByText('Second chat')).toBeNull();
  });

  it('opens an overlay listing every open session plus the new-session action', async () => {
    const user = userEvent.setup();
    renderTabs(true);

    await user.click(screen.getByRole('button', { name: 'Open sessions menu' }));

    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    // Ordered newest-first, exactly like the desktop pills (`getAllSessions`).
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Second chat',
      'First chat',
      'New session in this space',
    ]);
  });

  it('selects a session and closes the overlay', async () => {
    const user = userEvent.setup();
    const { onSessionSelect } = renderTabs(true);

    await user.click(screen.getByRole('button', { name: 'Open sessions menu' }));
    const target = screen
      .getAllByRole('menuitem')
      .find((item) => item.textContent === 'Second chat');
    await user.click(target as HTMLElement);

    expect(onSessionSelect).toHaveBeenCalledTimes(1);
    expect(onSessionSelect.mock.calls[0][0]).toMatchObject({ id: 's2', __projectId: 'p1' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('starts a new session from the overlay and closes it', async () => {
    const user = userEvent.setup();
    const { onNewSession } = renderTabs(true);

    await user.click(screen.getByRole('button', { name: 'Open sessions menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'New session in this space' }));

    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes the overlay on Escape', async () => {
    const user = userEvent.setup();
    renderTabs(true);

    await user.click(screen.getByRole('button', { name: 'Open sessions menu' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renders nothing when the space has no sessions', () => {
    const { container } = renderTabs(true, {
      selectedProject: { ...project, sessions: [] } as unknown as Project,
    });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('MainContentSessionTabs — desktop strip unchanged (#217)', () => {
  it('keeps one pill per session and no hamburger trigger', () => {
    renderTabs(false);

    expect(screen.queryByRole('button', { name: 'Open sessions menu' })).toBeNull();
    expect(screen.getByText('First chat')).toBeInTheDocument();
    expect(screen.getByText('Second chat')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New session in this space' })).toBeInTheDocument();
  });

  it('defaults to the desktop strip when isMobile is omitted', () => {
    render(
      <MainContentSessionTabs
        selectedProject={project}
        selectedSession={selectedSession}
        processingSessions={new Map() as SessionActivityMap}
        onSessionSelect={vi.fn()}
        onNewSession={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Open sessions menu' })).toBeNull();
    expect(screen.getByText('Second chat')).toBeInTheDocument();
  });

  it('selects a session when a pill is clicked', async () => {
    const user = userEvent.setup();
    const { onSessionSelect } = renderTabs(false);

    await user.click(screen.getByText('Second chat'));

    expect(onSessionSelect.mock.calls[0][0]).toMatchObject({ id: 's2', __projectId: 'p1' });
  });
});
