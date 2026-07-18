import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SessionActivity, SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { Project } from '../../../../types/app';

import SidebarConversationsList from './SidebarConversationsList';

// Regression coverage for the delete-gate footgun: a blocked-but-running session
// ranks as `blocked` (not `running`), so gating the archive/delete button on
// the ranking band would expose it for an in-flight session. The button must be
// gated on the live-run flag instead. These render the real component and assert
// the button's presence in the static markup.

const t = ((key: string, fallback?: string) => fallback ?? key) as never;
const noop = () => {};

function projectWith(sessionId: string, sessionExtra: Record<string, unknown> = {}): Project {
  return {
    projectId: 'p1',
    displayName: 'p1',
    fullPath: '/repos/p1',
    sessions: [{ id: sessionId, summary: sessionId, lastActivity: '2026-07-16T00:00:00Z', __provider: 'claude', ...sessionExtra }],
  } as unknown as Project;
}

function activity(blocked: boolean): SessionActivity {
  return { statusText: null, canInterrupt: true, startedAt: 0, blocked };
}

function render(
  activeSessions: SessionActivityMap,
  sessionId: string,
  sessionExtra: Record<string, unknown> = {},
): string {
  return renderToStaticMarkup(
    React.createElement(SidebarConversationsList, {
      projects: [projectWith(sessionId, sessionExtra)],
      activeSessions,
      selectedSession: null,
      currentTime: new Date('2026-07-17T00:00:00Z'),
      onSelect: noop,
      onNewConversation: noop,
      onCreateProject: noop,
      editingSession: null,
      editingSessionName: '',
      onEditingSessionNameChange: noop,
      onStartEditingSession: noop,
      onCancelEditingSession: noop,
      onSaveEditingSession: noop,
      onDeleteSession: noop,
      onArchiveSession: noop,
      t,
    }),
  );
}

test('hides the archive/delete button for a blocked-but-running session', () => {
  // Blocked run: present in activeSessions with blocked=true → ranks `blocked`,
  // isActive=true → destructive action must be absent from the DOM.
  const html = render(new Map([['s', activity(true)]]), 's');
  assert.ok(html.includes('tooltips.editSessionName'), 'rename button should still render');
  assert.ok(!html.includes('Archive session'), 'archive/delete button must be absent for an active session');
});

test('shows the archive/delete button for an idle session', () => {
  const html = render(new Map(), 's');
  assert.ok(html.includes('Archive session'), 'archive/delete button should render for an idle session');
});

test('renders a New conversation button above the list', () => {
  const html = render(new Map(), 's');
  assert.ok(html.includes('New conversation'), 'the New conversation action should render in the populated view');
});

test('badges a CLI-driven session with the origin chip (#71)', () => {
  const html = render(new Map(), 's', { origin: 'cli' });
  assert.ok(html.includes('Session not driven by cloudcli'), 'a cli-origin session shows the CLI origin badge');
});

test('leaves a cloudcli-driven session unbadged (#71)', () => {
  const html = render(new Map(), 's', { origin: 'cloudcli' });
  assert.ok(!html.includes('Session not driven by cloudcli'), 'a cloudcli-origin session has no CLI origin badge');
});

test('renders a New conversation button in the empty state (no projects/sessions)', () => {
  // No projects => no conversations => the empty-state branch renders. That branch
  // also mounts the button, so a fresh user can still start their first chat.
  const html = renderToStaticMarkup(
    React.createElement(SidebarConversationsList, {
      projects: [],
      activeSessions: new Map(),
      selectedSession: null,
      currentTime: new Date('2026-07-17T00:00:00Z'),
      onSelect: noop,
      onNewConversation: noop,
      onCreateProject: noop,
      editingSession: null,
      editingSessionName: '',
      onEditingSessionNameChange: noop,
      onStartEditingSession: noop,
      onCancelEditingSession: noop,
      onSaveEditingSession: noop,
      onDeleteSession: noop,
      onArchiveSession: noop,
      t,
    }),
  );
  assert.ok(html.includes('No conversations yet'), 'the empty state should render');
  assert.ok(html.includes('New conversation'), 'the empty state should still offer the New conversation action');
});
