import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const useVoiceAvailableMock = vi.fn();
const toggleMock = vi.fn();
const useTtsMock = vi.fn();

vi.mock('../../hooks/useVoiceAvailable', () => ({
  useVoiceAvailable: () => useVoiceAvailableMock(),
}));
vi.mock('../../hooks/useTts', () => ({
  useTts: (getText: () => string) => useTtsMock(getText),
}));

import MessageSpeakControl from './MessageSpeakControl';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MessageSpeakControl', () => {
  it('renders nothing when voice is not available', () => {
    useVoiceAvailableMock.mockReturnValue(false);
    useTtsMock.mockReturnValue({ state: 'idle', toggle: toggleMock, error: null });

    const { container } = render(<MessageSpeakControl content="hello" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the speak button and calls toggle on click when idle', () => {
    useVoiceAvailableMock.mockReturnValue(true);
    useTtsMock.mockReturnValue({ state: 'idle', toggle: toggleMock, error: null });

    render(<MessageSpeakControl content="hello world" />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(toggleMock).toHaveBeenCalledTimes(1);
  });

  it('shows a stop icon and title while playing', () => {
    useVoiceAvailableMock.mockReturnValue(true);
    useTtsMock.mockReturnValue({ state: 'playing', toggle: toggleMock, error: null });

    render(<MessageSpeakControl content="hello" />);
    expect(screen.getByRole('button').getAttribute('title')).toBe('Stop');
  });

  it('shows a loading spinner and title while loading', () => {
    useVoiceAvailableMock.mockReturnValue(true);
    useTtsMock.mockReturnValue({ state: 'loading', toggle: toggleMock, error: null });

    const { container } = render(<MessageSpeakControl content="hello" />);
    expect(container.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.getByRole('button').getAttribute('title')).toBe('Loading…');
  });

  it('renders an error tooltip when the hook reports an error', () => {
    useVoiceAvailableMock.mockReturnValue(true);
    useTtsMock.mockReturnValue({ state: 'idle', toggle: toggleMock, error: 'Playback failed' });

    render(<MessageSpeakControl content="hello" />);
    expect(screen.getByText('Playback failed')).toBeTruthy();
  });
});
