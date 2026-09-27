import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

const { default: VoiceSettingsTab } = await import('./VoiceSettingsTab');

beforeEach(() => {
  window.localStorage.clear();
});

describe('VoiceSettingsTab', () => {
  it('renders with voice disabled by default and hides backend fields', () => {
    render(<VoiceSettingsTab />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByPlaceholderText('https://api.openai.com/v1')).not.toBeInTheDocument();
  });

  it('enables voice and reveals backend configuration fields', () => {
    render(<VoiceSettingsTab />);
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByPlaceholderText('https://api.openai.com/v1')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('sk-…')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('whisper-1')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('tts-1')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('alloy')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('mp3')).toBeInTheDocument();
  });

  it('updates each voice config field and persists to localStorage', () => {
    render(<VoiceSettingsTab />);
    fireEvent.click(screen.getByRole('switch'));

    fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), {
      target: { value: 'https://custom.example.com/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
    fireEvent.change(screen.getByPlaceholderText('whisper-1'), { target: { value: 'whisper-2' } });
    fireEvent.change(screen.getByPlaceholderText('tts-1'), { target: { value: 'tts-2' } });
    fireEvent.change(screen.getByPlaceholderText('alloy'), { target: { value: 'nova' } });
    fireEvent.change(screen.getByPlaceholderText('mp3'), { target: { value: 'wav' } });

    expect(screen.getByDisplayValue('https://custom.example.com/v1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('sk-test')).toBeInTheDocument();
    expect(screen.getByDisplayValue('whisper-2')).toBeInTheDocument();
    expect(screen.getByDisplayValue('tts-2')).toBeInTheDocument();
    expect(screen.getByDisplayValue('nova')).toBeInTheDocument();
    expect(screen.getByDisplayValue('wav')).toBeInTheDocument();

    const stored = JSON.parse(window.localStorage.getItem('voiceConfig') || '{}');
    expect(stored.baseUrl).toBe('https://custom.example.com/v1');
    expect(stored.ttsVoice).toBe('nova');
  });
});
