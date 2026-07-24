import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@/types/app';
import i18n from '@/i18n/config.js';

import type { SessionWithProvider } from '../../types/types';

import SidebarConversationsList from './SidebarConversationsList';
import SidebarSessionItem from './SidebarSessionItem';

/*
 * Touch reveal for row actions (#244).
 *
 * The rename + archive cluster on session and conversation rows is revealed on
 * hover. A touch device has no hover, so the cluster stayed at `opacity-0` —
 * invisible, but still laid out and still clickable, directly on top of the
 * row's timestamp. On a phone the user sees "11m", taps near it, and hits an
 * invisible archive button (shift-clicking which deletes permanently).
 *
 * Project rows already carried the hand-written `touch:opacity-100` escape
 * hatch; session and conversation rows never got it. Revealing the cluster is
 * only half the fix — once permanently visible it must also stop sharing
 * coordinates with the timestamp, hence the reserved padding.
 */

const t = i18n.getFixedT('en', ['sidebar', 'common']);
const NOW = new Date('2026-07-24T12:00:00.000Z');

const project = {
  projectId: 'p1',
  displayName: 'demo',
  fullPath: '/repo/demo',
} as Project;

const session = {
  id: 's1',
  summary: 'a conversation',
  lastActivity: '2026-07-24T11:49:00.000Z',
  messageCount: 3,
  __provider: 'claude',
} as unknown as SessionWithProvider;

const rowActions = {
  editingSession: null,
  editingSessionName: '',
  onEditingSessionNameChange: vi.fn(),
  onStartEditingSession: vi.fn(),
  onCancelEditingSession: vi.fn(),
  onSaveEditingSession: vi.fn(),
  onDeleteSession: vi.fn(),
  onArchiveSession: vi.fn(),
};

function renderSessionRow() {
  return render(
    <SidebarSessionItem
      project={project}
      session={session}
      selectedSession={null}
      isProcessing={false}
      needsAttention={false}
      currentTime={NOW}
      onProjectSelect={vi.fn()}
      onSessionSelect={vi.fn()}
      t={t}
      {...rowActions}
    />,
  );
}

function renderConversationsList() {
  return render(
    <SidebarConversationsList
      projects={[{ ...project, sessions: [session] } as Project]}
      activeSessions={new Map()}
      selectedSession={null}
      currentTime={NOW}
      onSelect={vi.fn()}
      onNewConversation={vi.fn()}
      onCreateProject={vi.fn()}
      t={t}
      {...rowActions}
    />,
  );
}

/**
 * jsdom applies no CSS, so `md:hidden` mobile markup mounts alongside the
 * desktop row. The hover-revealed cluster is the absolutely positioned one.
 */
function clusters(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('div[class*="absolute right-2"]'));
}

describe('SidebarSessionItem — touch row actions (#244)', () => {
  it('reveals the rename/archive cluster on coarse-pointer devices', () => {
    const { container } = renderSessionRow();

    const [cluster] = clusters(container);
    expect(cluster).toBeTruthy();
    expect(cluster.className).toContain('touch:opacity-100');
  });

  it('reserves room so the cluster never sits on top of the timestamp', () => {
    const { container } = renderSessionRow();

    // The desktop timestamp is the one with the hover fade-out treatment.
    const timestamp = container.querySelector<HTMLElement>('span[class*="group-hover:opacity-0"]');
    expect(timestamp?.textContent).toBe('11m');
    expect((timestamp?.parentElement as HTMLElement).className).toContain('touch:pr-16');
  });

  it('keeps the mouse behaviour: hidden until the row is hovered', () => {
    const { container } = renderSessionRow();

    const [cluster] = clusters(container);
    expect(cluster.className).toContain('opacity-0');
    expect(cluster.className).toContain('group-hover:opacity-100');
  });
});

describe('SidebarConversationsList — touch row actions (#244)', () => {
  it('reveals the rename/archive cluster on coarse-pointer devices', () => {
    const { container } = renderConversationsList();

    const [cluster] = clusters(container);
    expect(cluster).toBeTruthy();
    expect(cluster.className).toContain('touch:opacity-100');
  });

  it('reserves room on the row so the cluster clears the status indicator', () => {
    renderConversationsList();

    const row = screen.getByRole('link', { name: /a conversation/i });
    expect(row.className).toContain('touch:pr-16');
  });
});
