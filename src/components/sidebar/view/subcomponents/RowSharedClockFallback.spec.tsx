import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import type { ConversationListItem } from '../../utils/conversationList';
import type { SessionWithProvider } from '../../types/types';

import type { Project } from '@/types/app';
import i18n from '@/i18n/config.js';


/*
 * Every other sidebar row spec (SidebarSessionItem.test.tsx,
 * SidebarConversationsList.test.tsx, RowMemoization.render-count.spec.tsx)
 * pins time deterministically by passing an explicit `currentTime` prop —
 * which is exactly the code path production no longer uses. Production omits
 * `currentTime` entirely so these rows fall back to `useMinuteClock()` (see
 * the sidebar perf audit's finding 4). That fallback branch (`currentTimeProp
 * ?? clockTime`) was previously never exercised by any test, so a wiring bug
 * there (wrong import, stale singleton, hook-order mistake) could ship
 * unnoticed. These specs render each row with *no* `currentTime` prop and
 * control the shared clock's initial snapshot via `vi.setSystemTime` +
 * `vi.resetModules()` (the module reads `new Date()` once at import time),
 * asserting the rendered relative-age label matches what the shared clock
 * — not a prop — produced.
 */

const t = i18n.getFixedT('en', ['sidebar', 'common']);
const noop = () => {};

function project(id: string): Project {
  return { projectId: id, displayName: id, fullPath: `/repos/${id}` } as Project;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SidebarSessionItem falls back to the shared minute clock when currentTime is omitted', () => {
  it('renders an age label derived from useMinuteClock, not a prop', async () => {
    vi.setSystemTime(new Date('2026-07-17T00:10:00.000Z'));
    vi.resetModules();
    const { default: SidebarSessionItem } = await import('./SidebarSessionItem');

    const session: SessionWithProvider = {
      id: 's1',
      summary: 'hello world',
      // 9 minutes before the system time the shared clock initializes to.
      lastActivity: '2026-07-17T00:01:00.000Z',
      __provider: 'claude',
    } as unknown as SessionWithProvider;

    render(
      <SidebarSessionItem
        project={project('p1')}
        session={session}
        selectedSession={null}
        isProcessing={false}
        needsAttention={false}
        // No `currentTime` prop — production shape.
        editingSession={null}
        editingSessionName=""
        onEditingSessionNameChange={noop}
        onStartEditingSession={noop}
        onCancelEditingSession={noop}
        onSaveEditingSession={noop}
        onProjectSelect={noop}
        onSessionSelect={noop}
        onDeleteSession={noop}
        onArchiveSession={noop}
        t={t}
      />,
    );

    expect(screen.getAllByText('9m').length).toBeGreaterThan(0);
  });
});

describe('ConversationRow falls back to the shared minute clock when currentTime is omitted', () => {
  it('renders an age label derived from useMinuteClock, not a prop', async () => {
    vi.setSystemTime(new Date('2026-07-17T00:10:00.000Z'));
    vi.resetModules();
    const { ConversationRow } = await import('./SidebarConversationsList');

    const item: ConversationListItem = {
      project: project('p1'),
      session: {
        id: 's1',
        summary: 'a conversation',
        __provider: 'claude',
      } as unknown as SessionWithProvider,
      status: 'recent',
      isActive: false,
      // 9 minutes before the system time the shared clock initializes to.
      activityTime: Date.parse('2026-07-17T00:01:00.000Z'),
    };

    render(
      <ConversationRow
        item={item}
        isSelected={false}
        // No `currentTime` prop — production shape.
        editingSession={null}
        editingSessionName=""
        onEditingSessionNameChange={noop}
        onStartEditingSession={noop}
        onCancelEditingSession={noop}
        onSaveEditingSession={noop}
        onDeleteSession={noop}
        onArchiveSession={noop}
        onSelect={noop}
        t={t}
      />,
    );

    expect(screen.getByText('9m')).toBeTruthy();
  });
});
