import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import SidebarHeader from './SidebarHeader';

// Return the English string fallback (mirrors how i18next resolves these keys)
// so labels render their real text; object option bags fall through to the key.
const t = ((key: string, fallback?: unknown) =>
  typeof fallback === 'string' ? fallback : key) as never;

const noop = () => {};

// The bulk "Archive older…" declutter action moved out of the sidebar header
// into Settings → Data (#187); it must no longer appear here.
const LEGACY_BULK_ARCHIVE_LABEL = 'Archive old conversations';

function renderHeader(
  overrides: Partial<React.ComponentProps<typeof SidebarHeader>> = {},
): string {
  const props: React.ComponentProps<typeof SidebarHeader> = {
    isPWA: false,
    isMobile: false,
    isLoading: false,
    projectsCount: 3,
    runningSessionsCount: 0,
    archivedSessionsCount: 0,
    isArchivedSessionsLoading: false,
    searchFilter: '',
    onSearchFilterChange: noop,
    onClearSearchFilter: noop,
    sidebarOverlay: 'none',
    onSetOverlay: noop,
    onRefresh: noop,
    isRefreshing: false,
    onCreateProject: noop,
    onCollapseSidebar: noop,
    t,
    ...overrides,
  };

  return renderToStaticMarkup(<SidebarHeader {...props} />);
}

test('the search + archived overlay toggles render when there are projects', () => {
  const markup = renderHeader({ projectsCount: 5 });

  assert.ok(markup.includes('Search chats'), 'expected the full-text search toggle');
  assert.ok(markup.includes('Archived'), 'expected the archived-overlay toggle');
  // #363: the ~28px full-width toggles floor their painted height to the 44px
  // touch floor (a real reflow, not the overlapping hit-h-44 overlay).
  assert.ok(markup.includes('touch:min-h-44'), 'expected the Search/Archived toggles to floor the touch height (#363)');
});

test('the search tools are hidden when there is nothing to show', () => {
  const markup = renderHeader({
    projectsCount: 0,
    runningSessionsCount: 0,
    archivedSessionsCount: 0,
    isArchivedSessionsLoading: false,
  });

  assert.ok(!markup.includes('Search chats'), 'no toggles when there is nothing active');
});

test('the legacy bulk archive-by-age control no longer lives in the header (#187)', () => {
  const markup = renderHeader({ projectsCount: 5 });

  assert.ok(
    !markup.includes(LEGACY_BULK_ARCHIVE_LABEL),
    'the bulk declutter action moved to Settings → Data and must not render in the sidebar header',
  );
});

test('the active overlay drives the search placeholder', () => {
  const searchMarkup = renderHeader({ sidebarOverlay: 'search' });
  assert.ok(
    searchMarkup.includes('search.conversationsPlaceholder'),
    'search overlay uses the conversation-search placeholder',
  );

  const archivedMarkup = renderHeader({ sidebarOverlay: 'archived' });
  assert.ok(
    archivedMarkup.includes('Search archived sessions...'),
    'archived overlay uses the archived placeholder',
  );
});
