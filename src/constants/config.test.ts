import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTH_DISABLED, DEFAULT_PROJECT_FOR_EMPTY_SHELL, IS_PLATFORM } from './config';

/*
 * `import.meta.env` is a Vite-only global; outside a Vite build (this runner) it does
 * not exist, so these must not throw and must fall back to their non-platform defaults.
 */
test('IS_PLATFORM and AUTH_DISABLED default to false outside a Vite build', () => {
  assert.equal(IS_PLATFORM, false);
  assert.equal(AUTH_DISABLED, false);
});

test('DEFAULT_PROJECT_FOR_EMPTY_SHELL is the OSS-mode default project (empty paths)', () => {
  assert.deepEqual(DEFAULT_PROJECT_FOR_EMPTY_SHELL, {
    projectId: 'default',
    displayName: 'default',
    fullPath: '',
    path: '',
  });
});
