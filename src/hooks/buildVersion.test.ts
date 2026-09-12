import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasUnsentComposerDraft,
  isAppIdle,
  resolveNewBuildAvailable,
  shouldAutoReload,
} from './buildVersion';

/**
 * cloudcli#458: useVersionCheck could never detect a new build because it compared
 * package.json's semver against /health, and this fork ships by ansible-pull with no
 * version bumps (1.36.3 across dozens of deploys). These pin the replacement comparison
 * and the idle-and-visible auto-reload predicate.
 */

// --- Comparison logic ---------------------------------------------------------

test('identical build SHA → no new build', () => {
  assert.equal(
    resolveNewBuildAvailable({
      embeddedSha: 'abc1234',
      embeddedVersion: '1.36.3',
      serverSha: 'abc1234',
      serverVersion: '1.36.3',
    }),
    false,
  );
});

test('SHA mismatch → new build available even when the semver matches', () => {
  assert.equal(
    resolveNewBuildAvailable({
      embeddedSha: 'abc1234',
      embeddedVersion: '1.36.3',
      serverSha: 'def5678',
      serverVersion: '1.36.3',
    }),
    true,
  );
});

test('missing build info on either side falls back to the semver comparison', () => {
  // Server predates the build identity (no sha): semver identical → no prompt.
  assert.equal(
    resolveNewBuildAvailable({
      embeddedSha: 'abc1234',
      embeddedVersion: '1.36.3',
      serverSha: null,
      serverVersion: '1.36.3',
    }),
    false,
  );
  // Dev bundle has no embedded sha: semver differs → prompt.
  assert.equal(
    resolveNewBuildAvailable({
      embeddedSha: '',
      embeddedVersion: '1.36.3',
      serverSha: null,
      serverVersion: '1.36.4',
    }),
    true,
  );
});

test('semver fallback matches when both build identities are absent and versions equal', () => {
  assert.equal(
    resolveNewBuildAvailable({
      embeddedSha: '',
      embeddedVersion: '1.36.3',
      serverSha: undefined,
      serverVersion: '1.36.3',
    }),
    false,
  );
});

test('an absent server version never prompts', () => {
  assert.equal(
    resolveNewBuildAvailable({
      embeddedSha: '',
      embeddedVersion: '1.36.3',
      serverSha: null,
      serverVersion: null,
    }),
    false,
  );
});

test('an empty-string serverSha is treated the same as a missing one, falling back to semver', () => {
  // The guard is `embeddedSha && serverSha`, so a falsy '' must fall back exactly like
  // `null`/`undefined` — not be compared as a (wrongly) mismatching SHA.
  assert.equal(
    resolveNewBuildAvailable({
      embeddedSha: 'abc1234',
      embeddedVersion: '1.36.3',
      serverSha: '',
      serverVersion: '1.36.3',
    }),
    false,
  );
  assert.equal(
    resolveNewBuildAvailable({
      embeddedSha: 'abc1234',
      embeddedVersion: '1.36.3',
      serverSha: '',
      serverVersion: '1.36.4',
    }),
    true,
  );
});

// --- Idle predicate -------------------------------------------------------------

test('idle only when neither a stream nor unsent composer text is present', () => {
  assert.equal(isAppIdle({ hasInFlightStream: false, hasUnsentComposerText: false }), true);
  assert.equal(isAppIdle({ hasInFlightStream: true, hasUnsentComposerText: false }), false);
  assert.equal(isAppIdle({ hasInFlightStream: false, hasUnsentComposerText: true }), false);
  assert.equal(isAppIdle({ hasInFlightStream: true, hasUnsentComposerText: true }), false);
});

// --- Auto-reload predicate -------------------------------------------------------

test('auto-reload fires only when a new build exists, the app is idle, and the tab just became visible', () => {
  assert.equal(
    shouldAutoReload({ newBuildAvailable: true, isIdle: true, becameVisibleAfterHidden: true }),
    true,
  );
  assert.equal(
    shouldAutoReload({ newBuildAvailable: false, isIdle: true, becameVisibleAfterHidden: true }),
    false,
  );
  assert.equal(
    shouldAutoReload({ newBuildAvailable: true, isIdle: false, becameVisibleAfterHidden: true }),
    false,
  );
  assert.equal(
    shouldAutoReload({ newBuildAvailable: true, isIdle: true, becameVisibleAfterHidden: false }),
    false,
  );
});

// --- Composer-draft scan -----------------------------------------------------------

class FakeStorage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

test('a non-empty composer draft blocks idle (reload would lose it)', () => {
  const storage = new FakeStorage();
  storage.setItem('draft_input_p1', 'half-typed message');
  assert.equal(hasUnsentComposerDraft(storage), true);
});

test('empty drafts, unrelated keys, or no storage do not block idle', () => {
  const storage = new FakeStorage();
  storage.setItem('draft_input_p1', '   ');
  storage.setItem('some-other-key', 'value');
  assert.equal(hasUnsentComposerDraft(storage), false);
  assert.equal(hasUnsentComposerDraft(new FakeStorage()), false);
  assert.equal(hasUnsentComposerDraft(null), false);
});

test('a draft cleared after send no longer blocks idle', () => {
  const storage = new FakeStorage();
  storage.setItem('draft_input_p1', 'sent text');
  storage.setItem('draft_input_p1', '');
  assert.equal(hasUnsentComposerDraft(storage), false);
});

test('a storage access that throws is treated as no draft, not a crash', () => {
  // Safari private mode, a storage-disabled sandboxed context, or a browser extension can
  // all make `length`/`key`/`getItem` throw. This runs inside the resume-time auto-reload
  // decision, so it must degrade like the rest of this codebase's storage access rather
  // than propagate.
  const throwing: Storage = {
    get length(): number {
      throw new Error('storage disabled');
    },
    key: () => null,
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
  assert.equal(hasUnsentComposerDraft(throwing), false);
});
