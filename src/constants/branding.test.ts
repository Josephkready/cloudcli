import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOUDCLI_WORDMARK_FONT_FAMILY } from './branding';

test('CLOUDCLI_WORDMARK_FONT_FAMILY is a non-empty CSS font-family stack', () => {
  assert.equal(typeof CLOUDCLI_WORDMARK_FONT_FAMILY, 'string');
  assert.ok(CLOUDCLI_WORDMARK_FONT_FAMILY.length > 0);
  assert.match(CLOUDCLI_WORDMARK_FONT_FAMILY, /system-ui/);
});
