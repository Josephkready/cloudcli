import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useStickyMount } from './useStickyMount';

/*
 * The shell tab is expensive to mount (#272), so `MainContent` keeps it in the
 * tree once opened and hides it instead. These cover the wiring the pure
 * reducer cannot: that the first activation renders in the same pass, and that
 * the effect commit does not undo the scope reset.
 */

describe('useStickyMount (#272)', () => {
  it('mounts on the first activation and stays mounted afterwards', () => {
    const { result, rerender } = renderHook(
      ({ isActive }: { isActive: boolean }) => useStickyMount(isActive, 'project-a'),
      { initialProps: { isActive: false } },
    );

    expect(result.current).toBe(false);

    rerender({ isActive: true });
    expect(result.current).toBe(true);

    rerender({ isActive: false });
    expect(result.current).toBe(true);
  });

  it('drops the surface when the scope changes and does not resurrect it', () => {
    const { result, rerender } = renderHook(
      ({ isActive, key }: { isActive: boolean; key: string }) => useStickyMount(isActive, key),
      { initialProps: { isActive: true, key: 'project-a' } },
    );

    rerender({ isActive: false, key: 'project-a' });
    expect(result.current).toBe(true);

    rerender({ isActive: false, key: 'project-b' });
    expect(result.current).toBe(false);

    // The effect from the previous scope must not flip it back on.
    rerender({ isActive: false, key: 'project-b' });
    expect(result.current).toBe(false);
  });

  it('keeps the surface when the scope changes while it is the active tab', () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useStickyMount(true, key),
      { initialProps: { key: 'project-a' } },
    );

    rerender({ key: 'project-b' });
    expect(result.current).toBe(true);
  });
});
