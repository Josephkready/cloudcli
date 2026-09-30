import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Project } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';

import SidebarSessionItem from './SidebarSessionItem';

// Regression coverage for the Projects-view row (twin of the Conversations-view
// SidebarConversationsList test). The destructive actions — the hover trash
// button and the new right-click context menu — are gated on `isProcessing`, so
// an in-flight session must not expose archive/delete. These render the real
// component to static markup and assert the gating.

const t = ((key: string, fallback?: string) => fallback ?? key) as never;
const noop = () => {};

const project = {
  projectId: 'p1',
  projectPath: '/repos/p1',
  displayName: 'p1',
  fullPath: '/repos/p1',
} as unknown as Project;

const session = {
  id: 's1',
  summary: 'hello world',
  lastActivity: '2026-07-16T00:00:00Z',
  __provider: 'claude',
} as unknown as SessionWithProvider;

function render(isProcessing: boolean, editingSession: string | null = null): string {
  return renderToStaticMarkup(
    React.createElement(SidebarSessionItem, {
      project,
      session,
      selectedSession: null,
      isProcessing,
      needsAttention: false,
      currentTime: new Date('2026-07-17T00:00:00Z'),
      editingSession,
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
    } as never),
  );
}

test('renders the in-app session link', () => {
  assert.ok(render(false).includes('href="/session/s1"'), 'the row should link to the session');
});

test('shows the archive/delete affordance for an idle session', () => {
  const html = render(false);
  assert.ok(html.includes('Archive session'), 'the archive/delete button should render when idle');
  assert.ok(html.includes('tooltips.editSessionName'), 'the rename button should render');
});

test('hides the archive/delete affordance while a run is processing', () => {
  const html = render(true);
  assert.ok(
    !html.includes('Archive session'),
    'archive/delete must be absent for a processing session',
  );
  assert.ok(html.includes('tooltips.editSessionName'), 'the rename button should still render');
});

test('keeps the context menu closed by default (opens only on right-click)', () => {
  assert.ok(!render(false).includes('role="menu"'), 'no menu should be rendered until right-click');
});

test('labels the inline rename field (its only accessible name; vdebug rename-session targets it)', () => {
  const html = render(false, 's1');
  assert.match(html, /<input[^>]*aria-label="tooltips\.editSessionName"/);
});
