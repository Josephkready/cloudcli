import test, { afterEach, beforeEach } from 'node:test';
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

// #216 made "hide CLI-origin chats" a global preference read from
// `claude-settings`. The `tsx --test` runner has no DOM, so stub the one method
// the reader touches; tests that care about CLI sessions opt out of hiding.
let settingsStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (key: string) => (key in settingsStore ? settingsStore[key] : null),
  setItem: (key: string, value: string) => {
    settingsStore[key] = value;
  },
  removeItem: (key: string) => {
    delete settingsStore[key];
  },
  clear: () => {
    settingsStore = {};
  },
} as unknown as Storage;

function showCliOriginChats() {
  settingsStore['claude-settings'] = JSON.stringify({ hideCliOriginChats: false });
}

beforeEach(() => {
  settingsStore = {};
  (globalThis as { localStorage?: Storage }).localStorage = localStorageStub;
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

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
  // The badge only applies once CLI sessions are shown at all (#216).
  showCliOriginChats();
  const html = render(new Map(), 's', { origin: 'cli' });
  assert.ok(html.includes('Session not driven by cloudcli'), 'a cli-origin session shows the CLI origin badge');
});

test('leaves a cloudcli-driven session unbadged (#71)', () => {
  const html = render(new Map(), 's', { origin: 'cloudcli' });
  assert.ok(!html.includes('Session not driven by cloudcli'), 'a cloudcli-origin session has no CLI origin badge');
});

test('hides a CLI-origin session by default (#216)', () => {
  // Nothing stored => preference defaults ON => the only session is filtered
  // out, so the list falls through to its empty state.
  const html = render(new Map(), 's', { origin: 'cli' });
  assert.ok(!html.includes('Session not driven by cloudcli'), 'the CLI badge must not render for a hidden session');
  assert.ok(!html.includes('>s</'), 'the CLI-origin session title must not render');
});

test('shows a CLI-origin session again when the preference is off (#216)', () => {
  showCliOriginChats();
  const html = render(new Map(), 's', { origin: 'cli' });
  assert.ok(html.includes('Session not driven by cloudcli'), 'the CLI session reappears with its badge');
});

test('never hides a cloudcli-origin session (#216)', () => {
  const html = render(new Map(), 's', { origin: 'cloudcli' });
  assert.ok(html.includes('Archive session'), 'a cloudcli-origin session still renders with the default preference');
});

test('shows the hidden-count affordance when a CLI session is filtered out (#216)', () => {
  // Default preference (ON) hides the only session, so the list is empty. The
  // affordance must surface how many are hidden and offer a Show action.
  const html = render(new Map(), 's', { origin: 'cli' });
  assert.ok(html.includes('1 CLI chats hidden'), 'the affordance should render the hidden count');
  assert.ok(html.includes('>Show<'), 'the affordance should offer a Show action');
});

test('omits the hidden-count affordance when CLI chats are shown (#216)', () => {
  showCliOriginChats();
  const html = render(new Map(), 's', { origin: 'cli' });
  assert.ok(!html.includes('CLI chats hidden'), 'no affordance when the preference is off');
});

test('omits the hidden-count affordance when nothing is hidden (#216)', () => {
  const html = render(new Map(), 's', { origin: 'cloudcli' });
  assert.ok(!html.includes('CLI chats hidden'), 'no affordance when no CLI session is filtered');
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
