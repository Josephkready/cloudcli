import assert from 'node:assert/strict';
import test from 'node:test';

import { isReservedDotOnlyId } from '@/shared/session-id-guards.js';

test('isReservedDotOnlyId flags ids made entirely of dots', () => {
  assert.equal(isReservedDotOnlyId('.'), true);
  assert.equal(isReservedDotOnlyId('..'), true);
  assert.equal(isReservedDotOnlyId('...'), true);
  assert.equal(isReservedDotOnlyId('.'.repeat(40)), true);
});

test('isReservedDotOnlyId leaves ids that merely contain dots alone', () => {
  // The guard must stay narrow — these are legitimate id shapes and rejecting
  // them would break real sessions.
  assert.equal(isReservedDotOnlyId('.hidden'), false);
  assert.equal(isReservedDotOnlyId('a.b'), false);
  assert.equal(isReservedDotOnlyId('v2.0'), false);
  assert.equal(isReservedDotOnlyId('..a'), false);
  assert.equal(isReservedDotOnlyId('a..'), false);
});

test('isReservedDotOnlyId does not flag the empty string', () => {
  // Empty is invalid for other reasons (each caller rejects it via its own
  // length/allow-list check); this guard is only about reserved names, and
  // `/^\.+$/` requiring at least one dot is what keeps the two concerns apart.
  assert.equal(isReservedDotOnlyId(''), false);
});
