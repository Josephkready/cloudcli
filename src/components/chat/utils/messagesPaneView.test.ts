import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMessagesPaneView } from './messagesPaneView';

/*
 * The chat pane used to have only three states, and "the load failed" was not
 * one of them: a failed load left zero messages, which fell through to the
 * provider-selection empty state — the "start a new conversation" screen. To a
 * user with a long thread open, that is indistinguishable from their
 * conversation having been deleted.
 *
 * `error` has to outrank `empty` for exactly that reason.
 */

const base = {
  isLoadingSessionMessages: false,
  isProcessing: false,
  messageCount: 0,
  loadFailed: false,
};

test('renders messages whenever there are any', () => {
  assert.equal(resolveMessagesPaneView({ ...base, messageCount: 3 }), 'messages');
});

test('renders the loading state while the initial fetch is in flight', () => {
  assert.equal(
    resolveMessagesPaneView({ ...base, isLoadingSessionMessages: true }),
    'loading',
  );
});

test('renders the loading state while a run is processing with nothing yet', () => {
  assert.equal(resolveMessagesPaneView({ ...base, isProcessing: true }), 'loading');
});

test('renders the empty state for a genuinely empty session', () => {
  assert.equal(resolveMessagesPaneView(base), 'empty');
});

test('renders the error state when the load failed', () => {
  assert.equal(resolveMessagesPaneView({ ...base, loadFailed: true }), 'error');
});

test('a failed load never falls through to the empty state', () => {
  // The regression this exists to prevent: `error` must win over `empty` when
  // both are technically true (a failure leaves zero messages behind).
  assert.notEqual(resolveMessagesPaneView({ ...base, loadFailed: true }), 'empty');
});

test('keeps showing messages already on screen even if a later load failed', () => {
  // A refresh can fail after a successful initial load. The user is mid-read;
  // blanking the thread to show an error would recreate the original bug.
  assert.equal(
    resolveMessagesPaneView({ ...base, loadFailed: true, messageCount: 12 }),
    'messages',
  );
});

test('loading outranks error so a retry shows progress, not the stale failure', () => {
  assert.equal(
    resolveMessagesPaneView({ ...base, loadFailed: true, isLoadingSessionMessages: true }),
    'loading',
  );
});
