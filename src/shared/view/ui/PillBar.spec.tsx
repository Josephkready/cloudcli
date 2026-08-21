import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Pill, PillBar } from './PillBar';

/*
 * #363: PillBar pills render as short as 24px in the primary tab bar — below the
 * repo's 44px touch floor. Every pill floors its touch height with the shared
 * `touch:hit-h-44` overlay (height-only, because PillBar is a gap-[2px] row where
 * a 44px-wide overlay would steal taps from the neighbour). This pins the class
 * on so a future restyle can't silently drop it.
 */
describe('Pill touch target (#363)', () => {
  it('floors the touch height with touch:hit-h-44', () => {
    render(
      <PillBar>
        <Pill isActive onClick={vi.fn()}>
          Chat
        </Pill>
      </PillBar>,
    );
    const pill = screen.getByRole('button', { name: 'Chat' });
    expect(pill.className).toContain('touch:hit-h-44');
    // Height-only, never both axes — a full 44px-wide overlay would spill onto
    // the adjacent pill in the gap-[2px] row.
    expect(pill.className).not.toContain('touch:hit-44');
  });
});
