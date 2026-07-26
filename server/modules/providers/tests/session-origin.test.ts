import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveSessionOrigin } from '@/modules/providers/services/session-origin.js';

test('matching app/provider ids identify a disk-discovered CLI session', () => {
  assert.equal(deriveSessionOrigin('native-id', 'native-id'), 'cli');
});

test('a distinct or pending provider id identifies a CloudCLI-created session', () => {
  assert.equal(deriveSessionOrigin('app-id', 'provider-id'), 'cloudcli');
  assert.equal(deriveSessionOrigin('app-id', null), 'cloudcli');
  assert.equal(deriveSessionOrigin('app-id', undefined), 'cloudcli');
});
