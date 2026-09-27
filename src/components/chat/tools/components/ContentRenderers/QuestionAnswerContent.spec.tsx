import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { QuestionAnswerContent } from './QuestionAnswerContent';

afterEach(() => {
  cleanup();
});

describe('QuestionAnswerContent interactions', () => {
  it('shows an answered badge (with a "(custom)" tag for a non-option answer) and expands to reveal the options', () => {
    render(
      <QuestionAnswerContent
        questions={[
          {
            question: 'Pick a color?',
            header: 'Color',
            options: [{ label: 'Red' }, { label: 'Blue', description: 'Cool tone' }],
          },
        ]}
        answers={{ 'Pick a color?': 'Blue, Green' }}
      />,
    );

    // Collapsed: answered badges show, including a "(custom)" tag for the
    // answer that doesn't match any known option (Green).
    expect(screen.getByText('Blue')).toBeTruthy();
    expect(screen.getByText('Green')).toBeTruthy();
    expect(screen.getByText('(custom)')).toBeTruthy();
    expect(screen.getByText('Color')).toBeTruthy();

    // Expand: reveals full option list with selected state + description +
    // a separate "custom answer" row for Green.
    fireEvent.click(screen.getByText('Pick a color?'));
    expect(screen.getByText('Red')).toBeTruthy();
    expect(screen.getByText('Cool tone')).toBeTruthy();

    // Collapse again.
    fireEvent.click(screen.getByText('Pick a color?'));
    expect(screen.queryByText('Cool tone')).toBeNull();
  });

  it('shows "No answer provided" inside an expanded, resolved, skipped question', () => {
    render(
      <QuestionAnswerContent
        questions={[{ question: 'Pick a fruit?', options: [{ label: 'Apple' }, { label: 'Banana' }] }]}
        answers={{ 'Other question?': 'x' }}
        resolved
      />,
    );

    fireEvent.click(screen.getByText('Pick a fruit?'));
    expect(screen.getByText('No answer provided')).toBeTruthy();
  });

  it('shows the index/total counter for a multi-question set', () => {
    render(
      <QuestionAnswerContent
        questions={[
          { question: 'Q1?', options: [{ label: 'A' }] },
          { question: 'Q2?', options: [{ label: 'B' }] },
        ]}
        answers={{}}
      />,
    );
    expect(screen.getByText('1/2')).toBeTruthy();
    expect(screen.getByText('2/2')).toBeTruthy();
  });

  it('renders nothing for an empty questions array', () => {
    const { container } = render(<QuestionAnswerContent questions={[]} answers={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a rotated chevron once expanded', () => {
    const { container } = render(
      <QuestionAnswerContent
        questions={[{ question: 'Expand me?', options: [{ label: 'Yes' }] }]}
        answers={{}}
      />,
    );
    fireEvent.click(screen.getByText('Expand me?'));
    expect(container.querySelector('svg.rotate-180')).toBeTruthy();
  });
});
