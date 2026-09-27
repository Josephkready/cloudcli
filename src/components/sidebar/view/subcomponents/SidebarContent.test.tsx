import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import SidebarContent from './SidebarContent';
import type { SidebarProjectListProps } from './SidebarProjectList';

// i18next stand-in: return the English fallback string when given one, else the
// key — so the section labels ("Spaces" / "Conversations") render real text.
const t = ((key: string, fallback?: unknown) =>
  typeof fallback === 'string' ? fallback : key) as never;

const noop = () => {};

const projectListProps: SidebarProjectListProps = {
  projects: [],
  filteredProjects: [],
  selectedProject: null,
  selectedSession: null,
  isLoading: false,
  loadingProgress: null,
  expandedProjects: new Set(),
  editingProject: null,
  editingName: '',
  initialSessionsLoaded: new Set(),
  currentTime: new Date(),
  editingSession: null,
  editingSessionName: '',
  deletingProjects: new Set(),
  getProjectSessions: () => [],
  onLoadMoreSessions: noop,
  loadingMoreProjects: new Set(),
  activeSessions: new Map(),
  isProjectStarred: () => false,
  onEditingNameChange: noop,
  onToggleProject: noop,
  onProjectSelect: noop,
  onToggleStarProject: noop,
  onStartEditingProject: noop,
  onCancelEditingProject: noop,
  onSaveProjectName: noop,
  onDeleteProject: noop,
  onSessionSelect: noop,
  onDeleteSession: noop,
  onArchiveSession: noop,
  onNewSession: noop,
  onEditingSessionNameChange: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  t,
};

function render(overrides: Partial<React.ComponentProps<typeof SidebarContent>> = {}): string {
  const props: React.ComponentProps<typeof SidebarContent> = {
    isPWA: false,
    isMobile: false,
    isLoading: false,
    projects: [],
    runningSessionsCount: 0,
    archivedProjects: [],
    archivedSessions: [],
    archivedSessionsCount: 0,
    isArchivedSessionsLoading: false,
    spacesExpanded: false,
    onSpacesExpandedChange: noop,
    searchFilter: '',
    onSearchFilterChange: noop,
    onClearSearchFilter: noop,
    sidebarOverlay: 'none',
    onSetOverlay: noop,
    conversationResults: null,
    isSearching: false,
    searchProgress: null,
    onRestoreArchivedProject: noop,
    onArchivedSessionClick: noop,
    onRestoreArchivedSession: noop,
    onDeleteArchivedSession: noop,
    onConversationResultClick: noop,
    onRefresh: noop,
    isRefreshing: false,
    onCreateProject: noop,
    onCollapseSidebar: noop,
    restartRequired: false,
    currentVersion: '0.0.0',
    onShowSettings: noop,
    projectListProps,
    t,
    ...overrides,
  };

  return renderToStaticMarkup(<SidebarContent {...props} />);
}

test('the default (none) overlay shows Spaces and Conversations at the same time', () => {
  const markup = render({ sidebarOverlay: 'none' });

  assert.ok(markup.includes('Spaces'), 'expected the Spaces section header');
  assert.ok(markup.includes('Conversations'), 'expected the Conversations section header');
});

test('the Spaces section renders a collapse toggle and is collapsed by default', () => {
  const markup = render({ sidebarOverlay: 'none', spacesExpanded: false });

  assert.ok(markup.includes('Toggle spaces'), 'expected the Spaces collapse toggle affordance');
  // #363: the ~27px full-width trigger floors its painted height to the 44px
  // touch floor (a real reflow, not the overlapping hit-h-44 overlay).
  assert.ok(markup.includes('touch:min-h-44'), 'expected the Spaces toggle to floor the touch height (#363)');
  assert.ok(markup.includes('aria-expanded="false"'), 'expected the trigger to report collapsed');
  assert.ok(markup.includes('data-state="closed"'), 'expected the Spaces region to render collapsed');
  assert.ok(!markup.includes('data-state="open"'), 'the Spaces region should not be open by default');
});

test('the Spaces section expands when the persisted flag is set', () => {
  const markup = render({ sidebarOverlay: 'none', spacesExpanded: true });

  assert.ok(markup.includes('aria-expanded="true"'), 'expected the trigger to report expanded');
  assert.ok(markup.includes('data-state="open"'), 'expected the Spaces region to render expanded');
  assert.ok(!markup.includes('data-state="closed"'), 'the Spaces region should not be collapsed when expanded');
});

test('the archived overlay replaces the two sections', () => {
  const markup = render({ sidebarOverlay: 'archived' });

  // The section headers only exist in the default two-section view.
  assert.ok(!markup.includes('>Spaces<'), 'Spaces section header should be hidden in the archived overlay');
  assert.ok(markup.includes('No archived items'), 'expected the empty-archive state');
});

test('the search overlay prompts for input before running a full-text search', () => {
  const markup = render({ sidebarOverlay: 'search', searchFilter: '' });

  assert.ok(
    markup.includes('Type at least 2 characters to search message contents.'),
    'expected the full-text search prompt',
  );
});

/*
 * The archived rows used to compute their age from a live `Date.now()` inside a
 * local helper. They now go through the shared `formatCompactAgeFromDate` and
 * read `projectListProps.currentTime` — the same 60s-ticked clock every other
 * sidebar row already used — so the whole list advances together.
 *
 * `currentTime` here is pinned to a fixed instant far from wall-clock: if the
 * row ever went back to reading the real clock, the rendered age would be the
 * years between then and now, never "3hr".
 */
test('archived session ages come from the injected clock, not the wall clock', () => {
  const currentTime = new Date('2026-07-16T12:00:00Z');
  const markup = render({
    sidebarOverlay: 'archived',
    archivedSessions: [
      {
        sessionId: 'archived-1',
        provider: 'claude',
        projectId: 'proj-1',
        projectPath: '/tmp/proj-1',
        projectDisplayName: 'proj-1',
        sessionTitle: 'An archived conversation',
        createdAt: '2026-07-16T06:00:00Z',
        updatedAt: '2026-07-16T09:00:00Z',
        lastActivity: '2026-07-16T09:00:00Z',
        isProjectArchived: false,
      },
    ],
    archivedSessionsCount: 1,
    projectListProps: { ...projectListProps, currentTime },
  });

  assert.ok(markup.includes('An archived conversation'), 'expected the archived row to render');
  assert.ok(markup.includes('>3hr<'), 'expected the age measured against the injected currentTime');
});

test('an archived session with no lastActivity renders no age instead of a blank badge', () => {
  const markup = render({
    sidebarOverlay: 'archived',
    archivedSessions: [
      {
        sessionId: 'archived-2',
        provider: 'claude',
        projectId: 'proj-1',
        projectPath: '/tmp/proj-1',
        projectDisplayName: 'proj-1',
        sessionTitle: 'Never active',
        createdAt: null,
        updatedAt: null,
        lastActivity: null,
        isProjectArchived: false,
      },
    ],
    archivedSessionsCount: 1,
    projectListProps: { ...projectListProps, currentTime: new Date('2026-07-16T12:00:00Z') },
  });

  assert.ok(markup.includes('Never active'), 'expected the archived row to render');
  assert.ok(!markup.includes('>3hr<'), 'no age should be derived from a null lastActivity');
});

test('the archived overlay shows a loading state while the archive is fetched', () => {
  const markup = render({ sidebarOverlay: 'archived', isArchivedSessionsLoading: true });

  assert.ok(markup.includes('Loading archive...'), 'expected the archive loading title');
});

test('the archived overlay shows a no-matching-sessions message when a search filters everything out', () => {
  const markup = render({ sidebarOverlay: 'archived', archivedSessionsCount: 2 });

  assert.ok(markup.includes('No matching archived items'), 'expected the filtered-empty state');
  assert.ok(markup.includes('Try a different search term.'));
});

test('an archived project with sessions renders its sessions, provider, and restore action', () => {
  const markup = render({
    sidebarOverlay: 'archived',
    archivedProjects: [
      {
        projectId: 'archived-proj-1',
        displayName: 'Old Project',
        fullPath: '/tmp/old-project',
        isArchived: true,
        sessions: [
          {
            id: 'sess-1',
            summary: 'A summarized chat',
            provider: 'codex',
            created_at: '2026-07-16T06:00:00Z',
            updated_at: '2026-07-16T09:00:00Z',
          },
        ],
      } as never,
    ],
    projectListProps: { ...projectListProps, currentTime: new Date('2026-07-16T12:00:00Z') },
  });

  assert.ok(markup.includes('Old Project'), 'expected the archived project name');
  assert.ok(markup.includes('Project archived'));
  assert.ok(markup.includes('A summarized chat'), 'expected the session summary as its title');
  assert.ok(markup.includes('Restore workspace'));
});

test('an archived project session falls back to its name, then its id, when no summary exists', () => {
  const markup = render({
    sidebarOverlay: 'archived',
    archivedProjects: [
      {
        projectId: 'archived-proj-2',
        displayName: 'Named-only project',
        fullPath: '/tmp/named',
        isArchived: true,
        sessions: [{ id: 'sess-named', name: 'A named session' }],
      } as never,
      {
        projectId: 'archived-proj-3',
        displayName: 'Id-only project',
        fullPath: '/tmp/idonly',
        isArchived: true,
        sessions: [{ id: 'sess-id-only' }],
      } as never,
    ],
  });

  assert.ok(markup.includes('A named session'));
  assert.ok(markup.includes('sess-id-only'));
});

test('grouped archived sessions (no owning project row) render with a restore and delete action', () => {
  const markup = render({
    sidebarOverlay: 'archived',
    archivedSessions: [
      {
        sessionId: 'grouped-1',
        provider: 'antigravity',
        projectId: null,
        projectPath: '/tmp/gone',
        projectDisplayName: 'Deleted project',
        sessionTitle: 'Orphaned chat',
        createdAt: null,
        updatedAt: null,
        lastActivity: '2026-07-16T09:00:00Z',
        isProjectArchived: false,
      },
    ],
    archivedSessionsCount: 1,
    projectListProps: { ...projectListProps, currentTime: new Date('2026-07-16T12:00:00Z') },
  });

  assert.ok(markup.includes('Deleted project'));
  assert.ok(markup.includes('Orphaned chat'));
  assert.ok(markup.includes('Restore session'));
  assert.ok(markup.includes('Delete permanently'));
  assert.ok(!markup.includes('Project archived'), 'ungrouped sessions have no owning project row');
});

test('the search overlay shows a searching spinner before any partial results arrive', () => {
  const markup = render({
    sidebarOverlay: 'search',
    searchFilter: 'hello',
    isSearching: true,
    conversationResults: null,
    searchProgress: { scannedProjects: 2, totalProjects: 5 },
  });

  assert.ok(markup.includes('search.searching'));
  assert.ok(markup.includes('2') && markup.includes('5'));
});

test('the search overlay shows a no-results message once a completed search finds nothing', () => {
  const markup = render({
    sidebarOverlay: 'search',
    searchFilter: 'hello',
    isSearching: false,
    conversationResults: { results: [], totalMatches: 0, query: 'hello' },
  });

  assert.ok(markup.includes('search.noResults'));
  assert.ok(markup.includes('search.tryDifferentQuery'));
});

test('the search overlay renders partial results with matches, highlights, and a progress bar', () => {
  const markup = render({
    sidebarOverlay: 'search',
    searchFilter: 'hello',
    isSearching: true,
    searchProgress: { scannedProjects: 1, totalProjects: 2 },
    conversationResults: {
      query: 'hello',
      totalMatches: 1,
      results: [
        {
          projectId: 'proj-1',
          projectName: 'proj-1',
          projectDisplayName: 'Proj One',
          sessions: [
            {
              sessionId: 'sess-1',
              sessionSummary: 'A summary',
              provider: 'codex',
              matches: [
                {
                  role: 'user',
                  snippet: 'say hello world',
                  highlights: [{ start: 4, end: 9 }],
                  timestamp: '2026-07-16T09:00:00Z',
                  provider: 'codex',
                },
              ],
            },
          ],
        },
      ],
    },
  });

  assert.ok(markup.includes('Proj One'));
  assert.ok(markup.includes('A summary'));
  assert.ok(markup.includes('<mark'), 'expected the matched substring to be highlighted');
  assert.ok(markup.includes('CODEX'.toLowerCase()) || markup.includes('codex'));
});
