import assert from 'node:assert/strict';
import test from 'node:test';

import { withGlobals } from '../test/nodeStubs';

import {
  CLAUDE_SETTINGS_CHANGED_EVENT,
  CLAUDE_SETTINGS_KEY,
  notifyClaudeSettingsChanged,
  subscribeToClaudeSettings,
} from './claudeSettings';

/*
 * #273 deleted the one-second `setInterval`s that used to re-read
 * `claude-settings`, so this event plumbing is now the *only* thing that keeps a
 * same-tab reader in sync with a write. A regression here is silent: the sidebar
 * simply shows stale settings, with no poll left to paper over it.
 *
 * `tsx --test` has no DOM, but a bare `EventTarget` provides the three methods
 * the module touches (`addEventListener`/`removeEventListener`/`dispatchEvent`),
 * so it stands in for `window` without pulling in jsdom. The cross-tab case uses
 * an `Event` tagged with a `key`, since Node has no `StorageEvent`.
 */

type FakeWindow = EventTarget;

const storageEvent = (key: string | null): Event =>
  Object.assign(new Event('storage'), { key });

function withFakeWindow(fn: (win: FakeWindow) => void): void {
  const win = new EventTarget();
  withGlobals({ window: win }, () => fn(win));
}

test('the key and event name are the ones every reader and writer agrees on', () => {
  assert.equal(CLAUDE_SETTINGS_KEY, 'claude-settings');
  assert.equal(CLAUDE_SETTINGS_CHANGED_EVENT, 'claudeSettingsChanged');
});

test('a same-tab notify reaches subscribers synchronously', () => {
  withFakeWindow(() => {
    let calls = 0;
    const unsubscribe = subscribeToClaudeSettings(() => {
      calls += 1;
    });

    notifyClaudeSettingsChanged();

    // No timer advanced, no microtask awaited: this is what replaced the poll.
    assert.equal(calls, 1);
    unsubscribe();
  });
});

test('every subscriber is notified, not just the first', () => {
  // Both the sidebar conversation list and the session tab strip mount
  // `useHideCliOriginChats` at once, so fan-out is load-bearing.
  withFakeWindow(() => {
    const seen: string[] = [];
    const unsubscribeA = subscribeToClaudeSettings(() => seen.push('a'));
    const unsubscribeB = subscribeToClaudeSettings(() => seen.push('b'));

    notifyClaudeSettingsChanged();

    assert.deepEqual(seen, ['a', 'b']);
    unsubscribeA();
    unsubscribeB();
  });
});

test('a cross-tab storage event for the settings key still notifies', () => {
  withFakeWindow((win) => {
    let calls = 0;
    const unsubscribe = subscribeToClaudeSettings(() => {
      calls += 1;
    });

    win.dispatchEvent(storageEvent(CLAUDE_SETTINGS_KEY));

    assert.equal(calls, 1);
    unsubscribe();
  });
});

test('a storage event for an unrelated key is ignored', () => {
  withFakeWindow((win) => {
    let calls = 0;
    const unsubscribe = subscribeToClaudeSettings(() => {
      calls += 1;
    });

    win.dispatchEvent(storageEvent('codex-settings'));

    assert.equal(calls, 0);
    unsubscribe();
  });
});

test('a whole-storage clear (key === null) counts as a change', () => {
  withFakeWindow((win) => {
    let calls = 0;
    const unsubscribe = subscribeToClaudeSettings(() => {
      calls += 1;
    });

    win.dispatchEvent(storageEvent(null));

    assert.equal(calls, 1);
    unsubscribe();
  });
});

test('unsubscribing detaches both the custom and the storage listener', () => {
  withFakeWindow((win) => {
    let calls = 0;
    const unsubscribe = subscribeToClaudeSettings(() => {
      calls += 1;
    });

    unsubscribe();
    notifyClaudeSettingsChanged();
    win.dispatchEvent(storageEvent(CLAUDE_SETTINGS_KEY));

    assert.equal(calls, 0);
  });
});

test('both helpers no-op without a window instead of throwing', () => {
  // The DOM-less unit runner and any SSR render still have to be able to call
  // the writers, which notify unconditionally.
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');
  assert.doesNotThrow(() => notifyClaudeSettingsChanged());

  const unsubscribe = subscribeToClaudeSettings(() => {
    assert.fail('a listener must not be invoked without a window');
  });
  assert.equal(typeof unsubscribe, 'function');
  assert.doesNotThrow(unsubscribe);
});
