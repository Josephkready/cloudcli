import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceInput } from './useVoiceInput';

const mockTranscribeVoice = vi.fn();
vi.mock('../../../lib/voiceApi', () => ({
  transcribeVoice: (...args: unknown[]) => mockTranscribeVoice(...args),
}));

const mockReadVoiceError = vi.fn();
vi.mock('../../../lib/voiceError', () => ({
  readVoiceError: (...args: unknown[]) => mockReadVoiceError(...args),
}));

vi.mock('../../../utils/featureUsage', () => ({
  recordFeatureUse: vi.fn(),
}));

/** A MediaRecorder fake with a synchronous `stop()` -> onstop hand-off. */
class FakeMediaRecorder {
  static isTypeSupported = vi.fn(() => true);
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType || 'audio/webm';
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: { size: 2000 } });
    this.onstop?.();
  }
}

const fakeTrack = { stop: vi.fn() };
const fakeStream = { getTracks: () => [fakeTrack] };
const mockGetUserMedia = vi.fn(() => Promise.resolve(fakeStream));

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: mockGetUserMedia } });
  vi.stubGlobal(
    'Blob',
    class {
      size: number;
      type: string;
      constructor(parts: { size: number }[] = [], opts: { type?: string } = {}) {
        this.size = parts.reduce((sum, p) => sum + (p.size || 0), 0);
        this.type = opts.type || '';
      }
    } as unknown as typeof Blob,
  );
  mockTranscribeVoice.mockReset();
  mockReadVoiceError.mockReset();
  mockGetUserMedia.mockClear().mockResolvedValue(fakeStream);
  fakeTrack.stop.mockClear();
});

describe('useVoiceInput — starting and stopping', () => {
  it('starts idle and moves to recording on toggle', async () => {
    const { result } = renderHook(() => useVoiceInput(vi.fn()));
    expect(result.current.state).toBe('idle');

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });

    expect(mockGetUserMedia).toHaveBeenCalled();
    expect(result.current.state).toBe('recording');
  });

  it('a second start call while already starting is a no-op', async () => {
    const { result } = renderHook(() => useVoiceInput(vi.fn()));

    await act(async () => {
      result.current.toggle();
      result.current.toggle();
      await Promise.resolve();
    });

    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
  });

  it('toggling while recording stops it', async () => {
    mockTranscribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: 'hello' }) });
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript));

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    expect(result.current.state).toBe('recording');

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onTranscript).toHaveBeenCalledWith('hello', false);
  });
});

describe('useVoiceInput — finishing a recording', () => {
  it('sends the transcript with the requested send flag', async () => {
    mockTranscribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: 'ship it' }) });
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript));

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    await act(async () => {
      result.current.stop({ send: true });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onTranscript).toHaveBeenCalledWith('ship it', true);
    expect(result.current.state).toBe('idle');
  });

  it('reports "No speech detected" for an empty transcript', async () => {
    mockTranscribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: '   ' }) });
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript, onError));

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    await act(async () => {
      result.current.stop();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith('No speech detected');
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('reports a failed transcription with the backend error message', async () => {
    mockTranscribeVoice.mockResolvedValue({ ok: false });
    mockReadVoiceError.mockResolvedValue('backend unreachable');
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput(vi.fn(), onError));

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    await act(async () => {
      result.current.stop();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith('Transcription failed: backend unreachable');
  });

  it('stop() does nothing when the recorder is already inactive', async () => {
    const { result } = renderHook(() => useVoiceInput(vi.fn()));

    expect(() => act(() => result.current.stop())).not.toThrow();
    expect(result.current.state).toBe('idle');
  });
});

describe('useVoiceInput — mic errors', () => {
  it('reports access-denied distinctly', async () => {
    const err = Object.assign(new Error('nope'), { name: 'NotAllowedError' });
    mockGetUserMedia.mockRejectedValueOnce(err);
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput(vi.fn(), onError));

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith('Microphone access denied.');
    expect(result.current.state).toBe('idle');
  });

  it('reports no-microphone-found distinctly', async () => {
    const err = Object.assign(new Error('nope'), { name: 'NotFoundError' });
    mockGetUserMedia.mockRejectedValueOnce(err);
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput(vi.fn(), onError));

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith('No microphone found.');
  });

  it('falls back to a generic mic error message', async () => {
    mockGetUserMedia.mockRejectedValueOnce(new Error('weird failure'));
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput(vi.fn(), onError));

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith('Mic error: weird failure');
  });
});

describe('useVoiceInput — unmount safety', () => {
  it('stops mic tracks on unmount mid-recording without calling back', async () => {
    const onTranscript = vi.fn();
    const { result, unmount } = renderHook(() => useVoiceInput(onTranscript));

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    expect(result.current.state).toBe('recording');

    unmount();

    expect(fakeTrack.stop).toHaveBeenCalled();
  });
});
