import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import SidebarHeader from './SidebarHeader';

// Return the English string fallback (mirrors how i18next resolves these keys)
// so aria-labels render their real text; object option bags fall through to the
// key, which is fine because those labels only render once the menu is opened.
const t = ((key: string, fallback?: unknown) =>
  typeof fallback === 'string' ? fallback : key) as never;

const noop = () => {};

const ARCHIVE_TRIGGER_LABEL = 'Archive old conversations';

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
    searchMode: 'projects',
    onSearchModeChange: noop,
    onRefresh: noop,
    isRefreshing: false,
    onCreateProject: noop,
    onCollapseSidebar: noop,
    onBulkArchiveOlderThanDays: noop,
    t,
    ...overrides,
  };

  return renderToStaticMarkup(<SidebarHeader {...props} />);
}

test('the bulk archive-by-age control renders when there are active sessions', () => {
  const markup = renderHeader({ projectsCount: 5 });

  assert.ok(
    markup.includes(ARCHIVE_TRIGGER_LABEL),
    'expected the archive-old-conversations trigger to be present',
  );
});

test('the bulk archive-by-age control is hidden when there are no active sessions', () => {
  const markup = renderHeader({
    projectsCount: 0,
    runningSessionsCount: 0,
    archivedSessionsCount: 0,
    isArchivedSessionsLoading: false,
  });

  assert.ok(
    !markup.includes(ARCHIVE_TRIGGER_LABEL),
    'the declutter action must not appear when there is nothing active to archive',
  );
});
