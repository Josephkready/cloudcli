import test from 'node:test';
import assert from 'node:assert/strict';

import type { SessionActivity, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { SessionWithProvider } from '../../sidebar/types/types';

import { buildSessionTabs, SESSION_TAB_STATUS_DOT } from './sessionTabs';

// Minimal SessionWithProvider factory — only the fields resolveStatus/tabs read.
function mkSession(id: string, extra: Partial<SessionWithProvider> = {}): SessionWithProvider {
  return { id, __provider: 'claude', ...extra } as SessionWithProvider;
}

function activity(blocked: boolean): SessionActivity {
  return { statusText: null, canInterrupt: false, startedAt: 0, blocked };
}

test('buildSessionTabs marks the selected session active and resolves each status', () => {
  const sessions = [
    mkSession('running'),
    mkSession('blocked'),
    mkSession('done', { last_completed_at: '2026-01-02T00:00:00Z', last_viewed_at: '2026-01-01T00:00:00Z' }),
    mkSession('recent'),
  ];
  const active: SessionActivityMap = new Map([
    ['running', activity(false)],
    ['blocked', activity(true)],
  ]);

  const tabs = buildSessionTabs(sessions, active, 'blocked');
  const byId = Object.fromEntries(tabs.map((t) => [t.id, t]));

  assert.equal(byId.running.status, 'running');
  assert.equal(byId.blocked.status, 'blocked');
  assert.equal(byId.done.status, 'done');
  assert.equal(byId.recent.status, 'recent');

  // Only the selected id is active.
  assert.equal(byId.blocked.isActive, true);
  assert.equal(byId.running.isActive, false);
  assert.equal(tabs.filter((t) => t.isActive).length, 1);
});

test('the currently-open session is never shown as done', () => {
  const sessions = [
    mkSession('open', { last_completed_at: '2026-01-02T00:00:00Z', last_viewed_at: '2026-01-01T00:00:00Z' }),
  ];
  const tabs = buildSessionTabs(sessions, new Map(), 'open');
  // Selected + finished-unseen would be "done" for any other session, but the
  // open one stays "recent" (you're looking at it).
  assert.equal(tabs[0].status, 'recent');
  assert.equal(tabs[0].isActive, true);
});

test('with no selection, nothing is active', () => {
  const tabs = buildSessionTabs([mkSession('a'), mkSession('b')], new Map(), null);
  assert.equal(tabs.every((t) => !t.isActive), true);
});

test('status-dot map: each status maps to its own distinct color, recent gets none', () => {
  // Exact values (not just truthiness) so a color swap between statuses fails.
  assert.equal(SESSION_TAB_STATUS_DOT.blocked, 'bg-amber-500');
  assert.equal(SESSION_TAB_STATUS_DOT.running, 'bg-emerald-500');
  assert.equal(SESSION_TAB_STATUS_DOT.done, 'bg-sky-500');
  assert.equal(SESSION_TAB_STATUS_DOT.recent, null);
});
