import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AskUserQuestionPanel } from './AskUserQuestionPanel';
import type { PendingPermissionRequest } from '../../../types/types';

/*
 * The "Other…" answer field carries an absolutely-positioned `Enter` hint over
 * its right edge. jsdom has no layout, so the overlap that produced #310 (the
 * tail of a typed answer disappearing under the badge on a 390px viewport)
 * cannot be measured here — what *can* be pinned is the invariant that fixes
 * it: the field reserves a right padding strip for the badge instead of using
 * symmetric padding. That is the exact edit a future restyle would undo.
 */

const REM_PER_TAILWIND_UNIT = 0.25;
/** right-2 (0.5rem) + the rendered badge (~2rem) — anything less overlaps. */
const MIN_RESERVED_REM = 2.5;

function renderPanel() {
  const request: PendingPermissionRequest = {
    requestId: 'req-1',
    toolName: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which approach?',
          header: 'Approach',
          options: [{ label: 'Rewrite' }, { label: 'Patch' }],
        },
      ],
    },
  };

  return render(<AskUserQuestionPanel request={request} onDecision={vi.fn()} />);
}

async function openOtherField() {
  const user = userEvent.setup();
  renderPanel();
  await user.click(screen.getByRole('button', { name: /other/i }));
  return { user, input: screen.getByPlaceholderText('Type your answer...') };
}

describe('AskUserQuestionPanel — "Other" field', () => {
  it('reserves room on the right for the Enter hint rather than padding symmetrically', async () => {
    const { input } = await openOtherField();
    const classes = input.className.split(/\s+/);

    expect(classes.filter((name) => /^px-/.test(name))).toEqual([]);

    const rightPadding = classes.find((name) => /^pr-\d+(\.\d+)?$/.test(name));
    expect(rightPadding).toBeDefined();
    expect(Number(rightPadding!.slice(3)) * REM_PER_TAILWIND_UNIT).toBeGreaterThanOrEqual(
      MIN_RESERVED_REM,
    );
  });

  it('keeps the Enter hint out of the input’s hit area', async () => {
    const { input } = await openOtherField();
    // The footer carries its own `Enter` hint, so scope the lookup to the badge
    // overlaying the field.
    const hint = input.parentElement!.querySelector('kbd');

    expect(hint).not.toBeNull();
    expect(hint!.className).toContain('pointer-events-none');
  });

  it('still records what the user types into the field', async () => {
    const { user, input } = await openOtherField();
    await user.type(input, 'a deliberately long free-form answer');

    expect(input).toHaveValue('a deliberately long free-form answer');
  });
});
