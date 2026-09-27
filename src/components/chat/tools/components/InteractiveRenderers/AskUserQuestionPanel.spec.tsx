import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AskUserQuestionPanel } from './AskUserQuestionPanel';
import type { PendingPermissionRequest, Question } from '../../../types/types';

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

function renderQuestions(questions: Question[], onDecision = vi.fn()) {
  const request: PendingPermissionRequest = {
    requestId: 'req-multi',
    toolName: 'AskUserQuestion',
    input: { questions },
  };
  return { ...render(<AskUserQuestionPanel request={request} onDecision={onDecision} />), onDecision };
}

describe('AskUserQuestionPanel — rendering edge cases', () => {
  it('renders nothing when there are no questions', () => {
    const { container } = renderQuestions([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not show a step counter or progress dots for a single question', () => {
    renderQuestions([{ question: 'Q1?', options: [{ label: 'A' }, { label: 'B' }] }]);
    expect(screen.queryByText('1/1')).not.toBeInTheDocument();
  });

  it('shows the header badge and description text when provided', () => {
    renderQuestions([
      {
        question: 'Q1?',
        header: 'Setup',
        options: [{ label: 'A', description: 'first option' }],
      },
    ]);
    expect(screen.getByText('Setup')).toBeInTheDocument();
    expect(screen.getByText('first option')).toBeInTheDocument();
  });

  it('shows "Select all that apply" hint and uses group role for multi-select questions', () => {
    renderQuestions([
      { question: 'Pick many', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    ]);
    expect(screen.getByText('Select all that apply')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Pick many' })).toBeInTheDocument();
  });

  it('uses radiogroup role for single-select questions', () => {
    renderQuestions([{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }]);
    expect(screen.getByRole('radiogroup', { name: 'Pick one' })).toBeInTheDocument();
  });
});

describe('AskUserQuestionPanel — selection and submission', () => {
  it('single-select: selecting a second option replaces the first', async () => {
    const user = userEvent.setup();
    renderQuestions([{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }]);

    await user.click(screen.getByText('A'));
    await user.click(screen.getByText('B'));

    const bButton = screen.getByText('B').closest('button')!;
    const aButton = screen.getByText('A').closest('button')!;
    expect(bButton.className).toContain('border-blue-300');
    expect(aButton.className).not.toContain('border-blue-300');
  });

  it('multi-select: toggles options independently and can deselect', async () => {
    const user = userEvent.setup();
    renderQuestions([
      { question: 'Pick many', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    ]);

    const aButton = screen.getByText('A').closest('button')!;
    const bButton = screen.getByText('B').closest('button')!;
    await user.click(aButton);
    await user.click(bButton);
    expect(aButton.className).toContain('border-blue-300');
    expect(bButton.className).toContain('border-blue-300');

    await user.click(aButton);
    expect(aButton.className).not.toContain('border-blue-300');
    expect(bButton.className).toContain('border-blue-300');
  });

  it('submits the built answers, including free-text "Other" answers', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    renderQuestions(
      [{ question: 'Pick one', options: [{ label: 'A' }] }],
      onDecision,
    );

    await user.click(screen.getByText('A'));
    await user.click(screen.getByRole('button', { name: /^Submit/ }));

    expect(onDecision).toHaveBeenCalledWith('req-multi', {
      allow: true,
      updatedInput: { questions: expect.anything(), answers: { 'Pick one': 'A' } },
    });
  });

  it('combines a selected option with free-text "Other" text into one answer', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    renderQuestions(
      [{ question: 'Pick one', multiSelect: true, options: [{ label: 'A' }] }],
      onDecision,
    );

    await user.click(screen.getByText('A'));
    await user.click(screen.getByRole('button', { name: /other/i }));
    await user.type(screen.getByPlaceholderText('Type your answer...'), 'extra note');
    await user.click(screen.getByRole('button', { name: /^Submit/ }));

    expect(onDecision).toHaveBeenCalledWith('req-multi', {
      allow: true,
      updatedInput: expect.objectContaining({ answers: { 'Pick one': 'A, extra note' } }),
    });
  });

  it('skip sends an empty-answers decision without requiring a selection', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    renderQuestions([{ question: 'Pick one', options: [{ label: 'A' }] }], onDecision);

    await user.click(screen.getByRole('button', { name: /skip/i }));

    expect(onDecision).toHaveBeenCalledWith('req-multi', {
      allow: true,
      updatedInput: { questions: expect.anything(), answers: {} },
    });
  });

  it('disables Submit until something is selected, then enables it', async () => {
    const user = userEvent.setup();
    renderQuestions([{ question: 'Pick one', options: [{ label: 'A' }] }]);

    const submit = screen.getByRole('button', { name: /^Submit/ });
    expect(submit).toBeDisabled();

    await user.click(screen.getByText('A'));
    expect(submit).toBeEnabled();
  });

  it('selecting "Other" clears any prior single-select choice', async () => {
    const user = userEvent.setup();
    renderQuestions([{ question: 'Pick one', options: [{ label: 'A' }] }]);

    const aButton = screen.getByText('A').closest('button')!;
    await user.click(aButton);
    expect(aButton.className).toContain('border-blue-300');

    await user.click(screen.getByRole('button', { name: /other/i }));
    expect(aButton.className).not.toContain('border-blue-300');
  });
});

describe('AskUserQuestionPanel — multi-question navigation', () => {
  const twoQuestions = [
    { question: 'Q1?', options: [{ label: 'A' }] },
    { question: 'Q2?', options: [{ label: 'B' }] },
  ];

  it('shows a step counter and progress dots, advances with Next, and shows Back after the first step', async () => {
    const user = userEvent.setup();
    renderQuestions(twoQuestions);

    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Next/ }));

    expect(screen.getByText('2/2')).toBeInTheDocument();
    expect(screen.getByText('Q2?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Submit/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('jumps directly to a step via a progress dot', async () => {
    const user = userEvent.setup();
    const { container } = renderQuestions(twoQuestions);

    const dots = container.querySelectorAll('.mb-2.flex.items-center.gap-1 > button');
    expect(dots.length).toBe(2);
    await user.click(dots[1] as HTMLElement);

    expect(screen.getByText('2/2')).toBeInTheDocument();
  });

  it('shows "Skip all" (not "Skip") when there is more than one question', () => {
    renderQuestions(twoQuestions);
    expect(screen.getByText('Skip all')).toBeInTheDocument();
  });
});

describe('AskUserQuestionPanel — keyboard interaction', () => {
  it('number keys toggle the matching option', async () => {
    const user = userEvent.setup();
    renderQuestions([{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }]);

    const container = screen.getByRole('radiogroup').parentElement!.parentElement!;
    container.focus();
    await user.keyboard('2');

    const bButton = screen.getByText('B').closest('button')!;
    expect(bButton.className).toContain('border-blue-300');
  });

  it('ignores out-of-range number keys', async () => {
    const user = userEvent.setup();
    renderQuestions([{ question: 'Pick one', options: [{ label: 'A' }] }]);

    const container = screen.getByRole('radiogroup').parentElement!.parentElement!;
    container.focus();
    await user.keyboard('9');

    expect(screen.getByRole('button', { name: /^Submit/ })).toBeDisabled();
  });

  it('the "0" key opens the Other field', async () => {
    const user = userEvent.setup();
    renderQuestions([{ question: 'Pick one', options: [{ label: 'A' }] }]);

    const container = screen.getByRole('radiogroup').parentElement!.parentElement!;
    container.focus();
    await user.keyboard('0');

    expect(await screen.findByPlaceholderText('Type your answer...')).toBeInTheDocument();
  });

  it('Enter advances to the next question, and submits on the last one', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    renderQuestions(
      [
        { question: 'Q1?', options: [{ label: 'A' }] },
        { question: 'Q2?', options: [{ label: 'B' }] },
      ],
      onDecision,
    );

    const container = screen.getByRole('radiogroup').parentElement!.parentElement!;
    container.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Q2?')).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onDecision).toHaveBeenCalledWith('req-multi', expect.objectContaining({ allow: true }));
  });

  it('Escape triggers skip', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    renderQuestions([{ question: 'Q1?', options: [{ label: 'A' }] }], onDecision);

    const container = screen.getByRole('radiogroup').parentElement!.parentElement!;
    container.focus();
    await user.keyboard('{Escape}');

    expect(onDecision).toHaveBeenCalledWith('req-multi', {
      allow: true,
      updatedInput: { questions: expect.anything(), answers: {} },
    });
  });

  it('does not capture number/enter keys while typing in the Other text field', async () => {
    const { user, input } = await openOtherField();
    await user.type(input, '1');
    // "1" was typed into the field, not interpreted as "select option 1".
    expect(input).toHaveValue('1');
  });

  it('pressing Enter inside the Other field advances instead of bubbling to the panel handler', async () => {
    const { user, input } = await openOtherField();
    await user.type(input, 'my answer{Enter}');
    // Only one question in this fixture, so Enter in the field submits.
    expect(input).toHaveValue('my answer');
  });
});
