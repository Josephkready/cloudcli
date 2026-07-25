import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  initialStickyMountState,
  nextStickyMountState,
  shouldRenderSticky,
} from './stickyMount.pure';

describe('stickyMount (#272)', () => {
  it('does not mount a surface that has never been opened', () => {
    const state = initialStickyMountState(false, 'project-a');

    assert.equal(shouldRenderSticky(state, false, 'project-a'), false);
  });

  it('renders on the first activation without waiting for a state commit', () => {
    const state = initialStickyMountState(false, 'project-a');

    // The click that opens the tab has to render the surface in the same pass;
    // waiting for the effect would cost an extra frame on every first open.
    assert.equal(shouldRenderSticky(state, true, 'project-a'), true);
  });

  it('keeps the surface mounted after it has been opened once', () => {
    const opened = nextStickyMountState(initialStickyMountState(false, 'project-a'), true, 'project-a');

    assert.deepEqual(opened, { key: 'project-a', mounted: true });
    assert.equal(shouldRenderSticky(opened, false, 'project-a'), true);
  });

  it('returns the same state object when nothing changed, so callers can skip a render', () => {
    const opened = { key: 'project-a', mounted: true };

    assert.equal(nextStickyMountState(opened, true, 'project-a'), opened);
    assert.equal(nextStickyMountState(opened, false, 'project-a'), opened);

    const closed = { key: 'project-a', mounted: false };
    assert.equal(nextStickyMountState(closed, false, 'project-a'), closed);
  });

  it('drops the surface when the scope key changes', () => {
    const opened = { key: 'project-a', mounted: true };

    // A terminal belonging to project A must not stay alive in the background
    // once project B is selected.
    assert.equal(shouldRenderSticky(opened, false, 'project-b'), false);

    const moved = nextStickyMountState(opened, false, 'project-b');
    assert.deepEqual(moved, { key: 'project-b', mounted: false });
  });

  it('re-arms in the new scope when the surface is active as the key changes', () => {
    const opened = { key: 'project-a', mounted: true };

    const moved = nextStickyMountState(opened, true, 'project-b');

    assert.deepEqual(moved, { key: 'project-b', mounted: true });
    assert.equal(shouldRenderSticky(moved, false, 'project-b'), true);
  });

  it('treats a missing key as its own scope', () => {
    const opened = nextStickyMountState(initialStickyMountState(false, null), true, null);

    assert.equal(shouldRenderSticky(opened, false, null), true);
    assert.equal(shouldRenderSticky(opened, false, 'project-a'), false);
  });
});
