import { describe, it, expect, vi, beforeEach } from 'vitest';

import { transcribeVoice, synthesizeVoice, voiceConfigSignature } from './voiceApi';

const setVoiceConfig = (config: Record<string, string>) => {
  window.localStorage.setItem('voiceConfig', JSON.stringify(config));
};

const mockResponse = () =>
  new Response(null, { status: 200, headers: {} });

describe('voiceApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse()));
  });

  describe('voiceConfigSignature', () => {
    it('returns the JSON-serialized voice config', () => {
      setVoiceConfig({ baseUrl: 'https://x.example', apiKey: 'k', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' });
      const sig = voiceConfigSignature();
      const parsed = JSON.parse(sig);
      expect(parsed.baseUrl).toBe('https://x.example');
      expect(parsed.apiKey).toBe('k');
    });

    it('falls back to defaults when nothing is stored', () => {
      const sig = voiceConfigSignature();
      const parsed = JSON.parse(sig);
      expect(parsed).toEqual({ baseUrl: '', apiKey: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' });
    });
  });

  describe('transcribeVoice', () => {
    it('posts directly to the configured base URL with Authorization header when baseUrl is set', async () => {
      setVoiceConfig({
        baseUrl: 'https://custom.example/',
        apiKey: 'secret-key',
        sttModel: 'whisper-large',
        ttsModel: '',
        ttsVoice: '',
        ttsFormat: '',
      });
      const blob = new Blob(['audio-bytes'], { type: 'audio/webm' });

      await transcribeVoice(blob, 'clip.webm');

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://custom.example/audio/transcriptions');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ Authorization: 'Bearer secret-key' });
      const body = init.body as FormData;
      expect(body.get('model')).toBe('whisper-large');
      expect(body.get('file')).toBeInstanceOf(Blob);
    });

    it('defaults the model to whisper-1 and omits Authorization when no apiKey is set', async () => {
      setVoiceConfig({ baseUrl: 'https://custom.example', apiKey: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' });
      const blob = new Blob(['audio-bytes']);

      await transcribeVoice(blob, 'clip.webm');

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.headers).toEqual({});
      const body = init.body as FormData;
      expect(body.get('model')).toBe('whisper-1');
    });

    it('falls back to the backend proxy endpoint with voice config headers when baseUrl is empty', async () => {
      setVoiceConfig({ baseUrl: '  ', apiKey: 'abc', sttModel: 'stt-x', ttsModel: '', ttsVoice: '', ttsFormat: '' });
      const blob = new Blob(['audio-bytes']);

      await transcribeVoice(blob, 'clip.webm');

      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('/api/voice/transcribe');
      expect(init.method).toBe('POST');
      expect(init.headers['x-voice-api-key']).toBe('abc');
      expect(init.headers['x-voice-stt-model']).toBe('stt-x');
      const body = init.body as FormData;
      expect(body.get('audio')).toBeInstanceOf(Blob);
      expect(body.get('file')).toBeNull();
    });
  });

  describe('synthesizeVoice', () => {
    it('posts JSON directly to the configured base URL including optional response_format', async () => {
      setVoiceConfig({
        baseUrl: 'https://custom.example',
        apiKey: 'k2',
        sttModel: '',
        ttsModel: 'tts-pro',
        ttsVoice: 'nova',
        ttsFormat: ' mp3 ',
      });
      const controller = new AbortController();

      await synthesizeVoice('hello world', controller.signal);

      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://custom.example/audio/speech');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer k2' });
      expect(init.signal).toBe(controller.signal);
      const parsedBody = JSON.parse(init.body as string);
      expect(parsedBody).toEqual({ model: 'tts-pro', voice: 'nova', input: 'hello world', response_format: 'mp3' });
    });

    it('omits response_format and Authorization when not configured', async () => {
      setVoiceConfig({ baseUrl: 'https://custom.example', apiKey: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' });
      const controller = new AbortController();

      await synthesizeVoice('hi', controller.signal);

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      const parsedBody = JSON.parse(init.body as string);
      expect(parsedBody).toEqual({ model: 'tts-1', voice: 'alloy', input: 'hi' });
    });

    it('falls back to the backend proxy endpoint when baseUrl is empty', async () => {
      setVoiceConfig({ baseUrl: '', apiKey: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' });
      const controller = new AbortController();

      await synthesizeVoice('proxied text', controller.signal);

      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('/api/voice/tts');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ text: 'proxied text' });
      expect(init.signal).toBe(controller.signal);
    });
  });
});
