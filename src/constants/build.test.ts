import assert from 'node:assert/strict';
import test from 'node:test';

import { BUILD_SHA } from './build';

/*
 * `__CLOUDCLI_BUILD_SHA__` is only defined by vite.config.js's `define` in an actual
 * Vite build; under tsx --test (this runner) the identifier does not exist at all, so
 * the `typeof` guard must fall back to '' rather than throwing a ReferenceError.
 */
test('BUILD_SHA falls back to an empty string outside a Vite build', () => {
  assert.equal(BUILD_SHA, '');
});
