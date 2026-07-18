import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionContextMenuActions } from './sessionContextMenu';

const labels = {
  openInNewTab: 'Open in new tab',
  rename: 'Rename',
  archive: 'Archive',
  delete: 'Delete permanently',
};

function handlersRecording(calls: string[]) {
  return {
    onOpenInNewTab: () => calls.push('open'),
    onRename: () => calls.push('rename'),
    onArchive: () => calls.push('archive'),
    onDelete: () => calls.push('delete'),
  };
}

test('offers open-in-new-tab, rename, archive and delete for an idle session', () => {
  const actions = buildSessionContextMenuActions({
    isActive: false,
    labels,
    handlers: handlersRecording([]),
  });

  assert.deepEqual(
    actions.map((action) => action.key),
    ['open-in-new-tab', 'rename', 'archive', 'delete'],
  );
});

test('omits the destructive actions while a run is live', () => {
  // Mirrors the hover cluster, which hides archive/delete for an active session
  // so an in-flight run can't be archived or deleted from the row.
  const actions = buildSessionContextMenuActions({
    isActive: true,
    labels,
    handlers: handlersRecording([]),
  });

  assert.deepEqual(
    actions.map((action) => action.key),
    ['open-in-new-tab', 'rename'],
  );
  assert.ok(
    !actions.some((action) => action.key === 'archive' || action.key === 'delete'),
    'archive and delete must be absent for an active session',
  );
});

test('marks only the permanent delete as a danger action', () => {
  const actions = buildSessionContextMenuActions({
    isActive: false,
    labels,
    handlers: handlersRecording([]),
  });

  const danger = actions.filter((action) => action.isDanger).map((action) => action.key);
  assert.deepEqual(danger, ['delete']);
});

test('separates the destructive group from navigation/rename with a divider', () => {
  const actions = buildSessionContextMenuActions({
    isActive: false,
    labels,
    handlers: handlersRecording([]),
  });

  const archive = actions.find((action) => action.key === 'archive');
  assert.ok(archive?.showDividerBefore, 'archive should start a new divided group');
  // Only one divider — the top (nav/rename) group is contiguous.
  assert.equal(actions.filter((action) => action.showDividerBefore).length, 1);
});

test('wires each action to its handler', () => {
  const calls: string[] = [];
  const actions = buildSessionContextMenuActions({
    isActive: false,
    labels,
    handlers: handlersRecording(calls),
  });

  for (const action of actions) {
    action.onSelect();
  }

  assert.deepEqual(calls, ['open', 'rename', 'archive', 'delete']);
});

test('uses the provided labels verbatim (i18n-resolved strings)', () => {
  const actions = buildSessionContextMenuActions({
    isActive: false,
    labels,
    handlers: handlersRecording([]),
  });

  assert.deepEqual(
    actions.map((action) => action.label),
    ['Open in new tab', 'Rename', 'Archive', 'Delete permanently'],
  );
});
