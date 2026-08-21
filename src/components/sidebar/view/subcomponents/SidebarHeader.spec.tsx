import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SidebarHeader from './SidebarHeader';

/*
 * #366: tapping "Search chats" is an unambiguous intent to type, so the search
 * field should focus itself instead of making the user tap a second time.
 * Browsing overlays ('none' = the sidebar just opened, 'archived') must NOT
 * grab focus and pop the keyboard.
 */

const t = ((key: string, fallback?: unknown) =>
  typeof fallback === 'string' ? fallback : key) as never;

function renderHeader(overrides: Partial<React.ComponentProps<typeof SidebarHeader>> = {}) {
  const props: React.ComponentProps<typeof SidebarHeader> = {
    isPWA: false,
    isMobile: false,
    isLoading: false,
    projectsCount: 3,
    runningSessionsCount: 0,
    archivedSessionsCount: 0,
    isArchivedSessionsLoading: false,
    searchFilter: '',
    onSearchFilterChange: vi.fn(),
    onClearSearchFilter: vi.fn(),
    sidebarOverlay: 'none',
    onSetOverlay: vi.fn(),
    onRefresh: vi.fn(),
    isRefreshing: false,
    onCreateProject: vi.fn(),
    onCollapseSidebar: vi.fn(),
    t,
    ...overrides,
  };
  return render(<SidebarHeader {...props} />);
}

const SEARCH_PLACEHOLDER = 'search.conversationsPlaceholder';

describe('SidebarHeader search autofocus (#366)', () => {
  it('focuses the search field when the search overlay opens', () => {
    renderHeader({ sidebarOverlay: 'search' });
    const active = document.activeElement as HTMLElement | null;
    expect(active?.tagName).toBe('INPUT');
    expect(active?.getAttribute('placeholder')).toBe(SEARCH_PLACEHOLDER);
  });

  it('does not grab focus when the sidebar is merely browsing (overlay none)', () => {
    renderHeader({ sidebarOverlay: 'none' });
    const active = document.activeElement as HTMLElement | null;
    // Nothing should be auto-focused — the user is browsing, not searching.
    expect(active?.getAttribute('placeholder')).not.toBe(SEARCH_PLACEHOLDER);
  });

  it('does not grab focus for the archived browsing overlay', () => {
    renderHeader({ sidebarOverlay: 'archived' });
    const active = document.activeElement as HTMLElement | null;
    expect(active?.getAttribute('placeholder')).not.toBe(SEARCH_PLACEHOLDER);
  });
});
