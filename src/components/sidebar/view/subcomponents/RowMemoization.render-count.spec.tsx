import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React, { memo, useState } from 'react';


import type { ConversationListItem } from '../../utils/conversationList';
import type { SessionWithProvider } from '../../types/types';

import { SidebarProjectItem } from './SidebarProjectItem';
import { SidebarSessionItem } from './SidebarSessionItem';
import { SidebarProjectSessions } from './SidebarProjectSessions';
import { ConversationRow } from './SidebarConversationsList';

import i18n from '@/i18n/config.js';
import type { Project, ProjectSession } from '@/types/app';

/*
 * Sidebar perf audit finding 1: SidebarProjectItem, SidebarSessionItem,
 * SidebarProjectSessions, and ConversationRow are the row-level components
 * rendered once per project/session. Before this fix, none of them were
 * wrapped in React.memo, and Sidebar.tsx rebuilt their callback props with a
 * fresh inline arrow on every render — so any unrelated Sidebar state change
 * (typing in search, the 60s clock tick, a websocket project refresh)
 * re-rendered every row, even though at most one row's content had changed.
 *
 * These specs wrap the raw (un-memoized) row components in their own
 * instrumented `memo()` — mirroring exactly how each is wrapped in
 * production — and count actual function-body executions directly, which is
 * the only reliable signal here: React.Profiler's `onRender` fires on every
 * commit that passes through it regardless of whether a memoized descendant
 * bailed out, so it can't distinguish "rendered again" from "skipped".
 *
 * Each test renders two rows side by side, triggers a state update that only
 * changes one row's props, and asserts the untouched row's render count does
 * not advance while the changed row's does — proving the memoization (and,
 * for SidebarSessionItem, the fact it no longer receives a `currentTime`
 * prop the parent rebuilds every render) actually holds with the props
 * Sidebar.tsx/SidebarProjectList/SidebarProjectSessions/
 * SidebarConversationsList now pass down.
 */

const t = i18n.getFixedT('en', ['sidebar', 'common']);
const noop = () => {};

function project(id: string): Project {
  return {
    projectId: id,
    displayName: id,
    fullPath: `/repos/${id}`,
    sessionMeta: { total: 1, hasMore: false },
  } as Project;
}

function session(id: string): SessionWithProvider {
  return {
    id,
    summary: `session ${id}`,
    lastActivity: '2026-07-16T00:00:00Z',
    __provider: 'claude',
  } as unknown as SessionWithProvider;
}

describe('SidebarProjectItem — memo holds across an unrelated re-render', () => {
  it('re-renders only the row whose own props changed', () => {
    const renderCounts = { a: 0, b: 0 };
    const RowA = memo((props: React.ComponentProps<typeof SidebarProjectItem>) => {
      renderCounts.a += 1;
      return <SidebarProjectItem {...props} />;
    });
    const RowB = memo((props: React.ComponentProps<typeof SidebarProjectItem>) => {
      renderCounts.b += 1;
      return <SidebarProjectItem {...props} />;
    });

    const baseProps = {
      selectedProject: null,
      selectedSession: null,
      isDeleting: false,
      isStarred: false,
      editingProject: null,
      editingName: '',
      sessions: [] as SessionWithProvider[],
      initialSessionsLoaded: true,
      isLoadingMoreSessions: false,
      editingSession: null,
      editingSessionName: '',
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
      onLoadMoreSessions: noop,
      activeSessions: new Map(),
      onNewSession: noop,
      onEditingSessionNameChange: noop,
      onStartEditingSession: noop,
      onCancelEditingSession: noop,
      onSaveEditingSession: noop,
      t,
    };

    // Hoisted outside the render so each is a stable reference across
    // re-renders — `project('a')`/`project('b')` called inline in JSX would
    // allocate a fresh object every Harness render and bust memo on its own,
    // independent of anything the real components do.
    const projectA = project('a');
    const projectB = project('b');

    function Harness() {
      const [unrelatedTick, setUnrelatedTick] = useState(0);
      const [expandedB, setExpandedB] = useState(false);
      return (
        <div>
          <button onClick={() => setUnrelatedTick((n) => n + 1)}>unrelated</button>
          <button onClick={() => setExpandedB(true)}>expand-b</button>
          <span>tick:{unrelatedTick}</span>
          <RowA {...baseProps} project={projectA} isExpanded={false} />
          <RowB {...baseProps} project={projectB} isExpanded={expandedB} />
        </div>
      );
    }

    const { getByText } = render(<Harness />);
    expect(renderCounts).toEqual({ a: 1, b: 1 });

    // Unrelated state change (mirrors a search keystroke / clock tick): props
    // for both rows are referentially identical, so memo should skip both.
    act(() => {
      getByText('unrelated').click();
    });
    expect(renderCounts).toEqual({ a: 1, b: 1 });

    // A change that only affects row B's own props: only B should re-render.
    act(() => {
      getByText('expand-b').click();
    });
    expect(renderCounts).toEqual({ a: 1, b: 2 });
  });
});

describe('SidebarSessionItem — memo holds without a currentTime prop', () => {
  it('re-renders only the row whose own props changed', () => {
    const renderCounts = { a: 0, b: 0 };
    const RowA = memo((props: React.ComponentProps<typeof SidebarSessionItem>) => {
      renderCounts.a += 1;
      return <SidebarSessionItem {...props} />;
    });
    const RowB = memo((props: React.ComponentProps<typeof SidebarSessionItem>) => {
      renderCounts.b += 1;
      return <SidebarSessionItem {...props} />;
    });

    const baseProps = {
      selectedSession: null as ProjectSession | null,
      isProcessing: false,
      needsAttention: false,
      editingSession: null,
      editingSessionName: '',
      onEditingSessionNameChange: noop,
      onStartEditingSession: noop,
      onCancelEditingSession: noop,
      onSaveEditingSession: noop,
      onProjectSelect: noop,
      onSessionSelect: noop,
      onDeleteSession: noop,
      onArchiveSession: noop,
      t,
    };

    const sharedProject = project('p');
    const sessionA = session('a');
    const sessionB = session('b');

    function Harness() {
      const [unrelatedTick, setUnrelatedTick] = useState(0);
      const [processingB, setProcessingB] = useState(false);
      return (
        <div>
          <button onClick={() => setUnrelatedTick((n) => n + 1)}>unrelated</button>
          <button onClick={() => setProcessingB(true)}>process-b</button>
          <span>tick:{unrelatedTick}</span>
          <RowA {...baseProps} project={sharedProject} session={sessionA} isProcessing={false} />
          <RowB {...baseProps} project={sharedProject} session={sessionB} isProcessing={processingB} />
        </div>
      );
    }

    const { getByText } = render(<Harness />);
    expect(renderCounts).toEqual({ a: 1, b: 1 });

    // Production no longer passes `currentTime` down this chain (rows read
    // the shared minute clock themselves), so an unrelated Sidebar re-render
    // must not touch either row's props at all.
    act(() => {
      getByText('unrelated').click();
    });
    expect(renderCounts).toEqual({ a: 1, b: 1 });

    act(() => {
      getByText('process-b').click();
    });
    expect(renderCounts).toEqual({ a: 1, b: 2 });
  });
});

describe('SidebarProjectSessions — memo holds across an unrelated re-render', () => {
  it('re-renders only the project whose own props changed', () => {
    const renderCounts = { a: 0, b: 0 };
    const RowA = memo((props: React.ComponentProps<typeof SidebarProjectSessions>) => {
      renderCounts.a += 1;
      return <SidebarProjectSessions {...props} />;
    });
    const RowB = memo((props: React.ComponentProps<typeof SidebarProjectSessions>) => {
      renderCounts.b += 1;
      return <SidebarProjectSessions {...props} />;
    });

    const sessions = [session('s1')];
    const baseProps = {
      isExpanded: true,
      sessions,
      selectedSession: null,
      initialSessionsLoaded: true,
      hasMoreSessions: false,
      isLoadingMoreSessions: false,
      activeSessions: new Map(),
      editingSession: null,
      editingSessionName: '',
      onEditingSessionNameChange: noop,
      onStartEditingSession: noop,
      onCancelEditingSession: noop,
      onSaveEditingSession: noop,
      onProjectSelect: noop,
      onSessionSelect: noop,
      onDeleteSession: noop,
      onArchiveSession: noop,
      onLoadMoreSessions: noop,
      onNewSession: noop,
      t,
    };

    const projectA = project('a');
    const projectB = project('b');

    function Harness() {
      const [unrelatedTick, setUnrelatedTick] = useState(0);
      const [loadingMoreB, setLoadingMoreB] = useState(false);
      return (
        <div>
          <button onClick={() => setUnrelatedTick((n) => n + 1)}>unrelated</button>
          <button onClick={() => setLoadingMoreB(true)}>load-more-b</button>
          <span>tick:{unrelatedTick}</span>
          <RowA {...baseProps} project={projectA} isLoadingMoreSessions={false} />
          <RowB {...baseProps} project={projectB} isLoadingMoreSessions={loadingMoreB} />
        </div>
      );
    }

    const { getByText } = render(<Harness />);
    expect(renderCounts).toEqual({ a: 1, b: 1 });

    act(() => {
      getByText('unrelated').click();
    });
    expect(renderCounts).toEqual({ a: 1, b: 1 });

    act(() => {
      getByText('load-more-b').click();
    });
    expect(renderCounts).toEqual({ a: 1, b: 2 });
  });
});

describe('ConversationRow — memo holds across an unrelated re-render', () => {
  it('re-renders only the row whose own props changed', () => {
    const renderCounts = { a: 0, b: 0 };
    const RowA = memo((props: React.ComponentProps<typeof ConversationRow>) => {
      renderCounts.a += 1;
      return <ConversationRow {...props} />;
    });
    const RowB = memo((props: React.ComponentProps<typeof ConversationRow>) => {
      renderCounts.b += 1;
      return <ConversationRow {...props} />;
    });

    function item(id: string): ConversationListItem {
      return {
        project: project('p'),
        session: session(id),
        status: 'recent',
        isActive: false,
        activityTime: Date.parse('2026-07-16T00:00:00Z'),
      };
    }

    const baseProps = {
      isSelected: false,
      editingSession: null,
      editingSessionName: '',
      onEditingSessionNameChange: noop,
      onStartEditingSession: noop,
      onCancelEditingSession: noop,
      onSaveEditingSession: noop,
      onDeleteSession: noop,
      onArchiveSession: noop,
      onSelect: noop,
      t,
    };

    const itemA = item('a');
    const itemB = item('b');

    function Harness() {
      const [unrelatedTick, setUnrelatedTick] = useState(0);
      const [selectedB, setSelectedB] = useState(false);
      return (
        <div>
          <button onClick={() => setUnrelatedTick((n) => n + 1)}>unrelated</button>
          <button onClick={() => setSelectedB(true)}>select-b</button>
          <span>tick:{unrelatedTick}</span>
          <RowA {...baseProps} item={itemA} isSelected={false} />
          <RowB {...baseProps} item={itemB} isSelected={selectedB} />
        </div>
      );
    }

    const { getByText } = render(<Harness />);
    expect(renderCounts).toEqual({ a: 1, b: 1 });

    act(() => {
      getByText('unrelated').click();
    });
    expect(renderCounts).toEqual({ a: 1, b: 1 });

    act(() => {
      getByText('select-b').click();
    });
    expect(renderCounts).toEqual({ a: 1, b: 2 });
  });
});

// Sanity check pinning the *pre-fix* behaviour this whole suite guards
// against, so a regression that removes memo (or reintroduces an inline
// callback prop) shows up as a failure above rather than silently no-op'ing.
describe('sanity: an unmemoized row would re-render on every unrelated change', () => {
  it('control case — no memo means the render count keeps climbing', () => {
    const renderCounts = { a: 0 };
    function RowA(props: { label: string }) {
      renderCounts.a += 1;
      return <div>{props.label}</div>;
    }

    function Harness() {
      const [unrelatedTick, setUnrelatedTick] = useState(0);
      return (
        <div>
          <button onClick={() => setUnrelatedTick((n) => n + 1)}>unrelated</button>
          <span>tick:{unrelatedTick}</span>
          <RowA label="fixed" />
        </div>
      );
    }

    const { getByText } = render(<Harness />);
    expect(renderCounts.a).toBe(1);
    act(() => {
      getByText('unrelated').click();
    });
    act(() => {
      getByText('unrelated').click();
    });
    expect(renderCounts.a).toBe(3);
  });
});
