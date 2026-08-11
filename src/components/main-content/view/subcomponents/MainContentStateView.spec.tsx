import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../types/app';

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
 * #326: on mobile the empty state was a dead end. It said "select a project
 * from the sidebar", but on mobile there IS no visible sidebar — it lives
 * behind the burger menu — so opening the app with no project selected landed
 * on a blank page with nothing to act on. The fix puts the project list on the
 * page itself, so the landing surface is the selector.
 *
 * Desktop is deliberately unchanged: the sidebar is already on screen there, so
 * an inline copy would be redundant.
 */

const project = (over: Partial<Project> = {}): Project => ({
  projectId: 'p1',
  displayName: 'mind',
  path: '/home/jkready/repos/mind',
  fullPath: '/home/jkready/repos/mind',
  ...over,
} as Project);

describe('MainContentStateView — mobile project selector (#326)', () => {
  const projects = [
    project({ projectId: 'p1', displayName: 'mind', path: '/home/jkready/repos/mind' }),
    project({ projectId: 'p2', displayName: 'cloudcli', path: '/home/jkready/repos/cloudcli' }),
  ];

  it('lists the projects on the page so mobile has something to act on', () => {
    render(
      <MainContentStateView
        mode="empty"
        isMobile
        onMenuClick={vi.fn()}
        projects={projects}
        onProjectSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /mind/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /cloudcli/ })).toBeTruthy();
  });

  it('selects the tapped project — the whole point of the change', async () => {
    const onProjectSelect = vi.fn();
    render(
      <MainContentStateView
        mode="empty"
        isMobile
        onMenuClick={vi.fn()}
        projects={projects}
        onProjectSelect={onProjectSelect}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /cloudcli/ }));

    expect(onProjectSelect).toHaveBeenCalledTimes(1);
    expect(onProjectSelect).toHaveBeenCalledWith(projects[1]);
  });

  it('preserves the order it was given, matching the sidebar', () => {
    render(
      <MainContentStateView
        mode="empty"
        isMobile
        onMenuClick={vi.fn()}
        projects={projects}
        onProjectSelect={vi.fn()}
      />,
    );

    const names = screen
      .getAllByTestId('mobile-project-option')
      .map((node) => node.textContent ?? '');
    expect(names[0]).toMatch(/mind/);
    expect(names[1]).toMatch(/cloudcli/);
  });

  it('does not duplicate the sidebar on desktop, where it is already visible', () => {
    render(
      <MainContentStateView
        mode="empty"
        isMobile={false}
        onMenuClick={vi.fn()}
        projects={projects}
        onProjectSelect={vi.fn()}
      />,
    );

    expect(screen.queryAllByTestId('mobile-project-option')).toHaveLength(0);
  });

  it('keeps the create-a-project guidance when there is nothing to pick', () => {
    render(
      <MainContentStateView
        mode="empty"
        isMobile
        onMenuClick={vi.fn()}
        projects={[]}
        onProjectSelect={vi.fn()}
      />,
    );

    expect(screen.queryAllByTestId('mobile-project-option')).toHaveLength(0);
    // Falling back to the onboarding copy is the right answer here — a list of
    // nothing would be a worse dead end than the tip.
    expect(screen.getByText(/Tip:/)).toBeTruthy();
  });

  it('shows nothing to pick while projects are still loading', () => {
    render(
      <MainContentStateView
        mode="loading"
        isMobile
        onMenuClick={vi.fn()}
        projects={projects}
        onProjectSelect={vi.fn()}
      />,
    );

    expect(screen.queryAllByTestId('mobile-project-option')).toHaveLength(0);
  });

  it('still renders the menu button, so the full sidebar stays reachable', () => {
    const onMenuClick = vi.fn();
    render(
      <MainContentStateView
        mode="empty"
        isMobile
        onMenuClick={onMenuClick}
        projects={projects}
        onProjectSelect={vi.fn()}
      />,
    );

    // The inline list is a shortcut, not a replacement: sessions, starring and
    // archive still live in the real sidebar.
    expect(screen.getAllByTestId('mobile-project-option').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/menu/i)).toBeTruthy();
  });
});
