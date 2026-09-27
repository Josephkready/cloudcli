import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import VoiceInputButton from './VoiceInputButton';

afterEach(() => {
  cleanup();
});

describe('VoiceInputButton', () => {
  it('renders the mic icon and calls onToggle when idle', () => {
    const onToggle = vi.fn();
    render(<VoiceInputButton state="idle" onToggle={onToggle} />);

    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows a stop icon while recording', () => {
    const { container } = render(<VoiceInputButton state="recording" onToggle={() => {}} />);
    // Square (stop) icon rendered instead of Mic.
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('shows a spinner while transcribing', () => {
    const { container } = render(<VoiceInputButton state="transcribing" onToggle={() => {}} />);
    expect(container.querySelector('.animate-spin')).toBeTruthy();
  });

  it('shows an error message tooltip when errorMsg is provided', () => {
    render(<VoiceInputButton state="idle" onToggle={() => {}} errorMsg="Mic permission denied" />);
    expect(screen.getByText('Mic permission denied')).toBeTruthy();
  });

  it('renders no error message when errorMsg is absent', () => {
    render(<VoiceInputButton state="idle" onToggle={() => {}} />);
    expect(screen.queryByText(/denied/)).toBeNull();
  });
});
