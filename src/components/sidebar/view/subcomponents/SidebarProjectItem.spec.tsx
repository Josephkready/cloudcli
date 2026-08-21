import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SessionWithProvider } from '../../types/types';

import SidebarProjectItem from './SidebarProjectItem';

import i18n from '@/i18n/config.js';
import type { Project } from '@/types/app';

/*
 * Session-count subtitle (#242). The desktop row rendered a bare, unlabeled
 * number ("0  - ...long/path") while the mobile card rendered "0 sessions".
 * The leading digit reads as a bullet or an index, not a count — both layouts
 * have to agree on the labelled form.
 */

function makeProject(total: number, overrides: Partial<Project> = {}): Project {
  return {
    projectId: 'p1',
    displayName: 'demo-app',
    fullPath: '/home/someone/repos/cloudcli-audit/demo-app',
    sessionMeta: { total, hasMore: false },
    ...overrides,
  } as Project;
}

function renderItem(project: Project) {
  render(
    <SidebarProjectItem
      project={project}
      selectedProject={null}
      selectedSession={null}
      isExpanded={false}
      isDeleting={false}
      isStarred={false}
      editingProject={null}
      editingName=""
      sessions={[] as SessionWithProvider[]}
      initialSessionsLoaded
      isLoadingMoreSessions={false}
      currentTime={new Date('2026-07-24T12:00:00Z')}
      editingSession={null}
      editingSessionName=""
      onEditingNameChange={vi.fn()}
      onToggleProject={vi.fn()}
      onProjectSelect={vi.fn()}
      onToggleStarProject={vi.fn()}
      onStartEditingProject={vi.fn()}
      onCancelEditingProject={vi.fn()}
      onSaveProjectName={vi.fn()}
      onDeleteProject={vi.fn()}
      onSessionSelect={vi.fn()}
      onDeleteSession={vi.fn()}
      onArchiveSession={vi.fn()}
      onLoadMoreSessions={vi.fn()}
      activeSessions={new Map()}
      onNewSession={vi.fn()}
      onEditingSessionNameChange={vi.fn()}
      onStartEditingSession={vi.fn()}
      onCancelEditingSession={vi.fn()}
      onSaveEditingSession={vi.fn()}
      t={i18n.getFixedT('en', ['sidebar', 'common'])}
    />,
  );
}

/**
 * jsdom applies no CSS, so the `md:hidden` mobile card and the
 * `hidden md:flex` desktop row both mount. `sidebar-project-row` is the
 * desktop one.
 */
function desktopSubtitle(): string {
  const row = screen.getByTestId('sidebar-project-row');
  return within(row).getByText(/session/i).textContent ?? '';
}

describe('SidebarProjectItem — session count subtitle (#242)', () => {
  it('labels the count on the desktop row instead of showing a bare number', () => {
    renderItem(makeProject(0));

    expect(desktopSubtitle()).toMatch(/^0 sessions/);
  });

  it('uses the singular form for exactly one session', () => {
    renderItem(makeProject(1));

    expect(desktopSubtitle()).toMatch(/^1 session\b/);
    expect(desktopSubtitle()).not.toMatch(/1 sessions/);
  });

  it('keeps the truncated path alongside the labelled count', () => {
    renderItem(makeProject(3));

    const subtitle = desktopSubtitle();
    expect(subtitle).toMatch(/3 sessions/);
    // Long paths keep their tail: `...` + the last 22 characters.
    expect(subtitle).toContain('loudcli-audit/demo-app');
  });

  it('matches the mobile card, which already labelled the count', () => {
    renderItem(makeProject(0));

    expect(screen.getAllByText(/^0 sessions/).length).toBeGreaterThanOrEqual(2);
  });
});

/*
 * #363: the 32px favorite-toggle button is below the repo's 44px touch floor.
 * It floors its touch height with the height-only `touch:hit-h-44` overlay
 * (height-only because the outer card's own onClick would otherwise hijack taps
 * in a widened star's hit zone). Pinned so a restyle can't silently drop it.
 */
describe('SidebarProjectItem — favorite toggle touch target (#363)', () => {
  it('floors the favorite button at the 44px touch height', () => {
    renderItem(makeProject(0));

    const starButton = screen
      .getAllByTitle('Add to favorites')
      .find((el) => el.tagName === 'BUTTON');
    expect(starButton?.className).toContain('touch:hit-h-44');
  });
});
