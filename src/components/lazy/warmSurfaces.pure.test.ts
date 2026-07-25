import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shouldWarmSurfaces } from './warmSurfaces.pure';

describe('shouldWarmSurfaces', () => {
  it('warms when the browser exposes no connection info', () => {
    assert.equal(shouldWarmSurfaces(undefined), true);
    assert.equal(shouldWarmSurfaces(null), true);
    assert.equal(shouldWarmSurfaces({}), true);
  });

  it('warms on an ordinary connection', () => {
    assert.equal(shouldWarmSurfaces({ effectiveType: '4g', saveData: false }), true);
    assert.equal(shouldWarmSurfaces({ effectiveType: '3g' }), true);
  });

  it('does not spend a metered user’s data on a tab they have not opened', () => {
    assert.equal(shouldWarmSurfaces({ saveData: true }), false);
    assert.equal(shouldWarmSurfaces({ saveData: true, effectiveType: '4g' }), false);
  });

  it('does not warm on 2G, where the bytes would be felt', () => {
    assert.equal(shouldWarmSurfaces({ effectiveType: '2g' }), false);
    assert.equal(shouldWarmSurfaces({ effectiveType: 'slow-2g' }), false);
  });
});
