import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { copyTextToClipboard } from './clipboard';

describe('copyTextToClipboard', () => {
  beforeEach(() => {
    // jsdom does not implement execCommand at all (not even as a stub), so
    // give it one to spy on before each test exercises the fallback path.
    if (!('execCommand' in document)) {
      (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false immediately for empty text without touching the clipboard', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    const result = await copyTextToClipboard('');
    expect(result).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('uses navigator.clipboard.writeText when available and succeeds', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const result = await copyTextToClipboard('hello world');
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello world');
  });

  it('falls back to execCommand when navigator.clipboard.writeText rejects', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true);

    const result = await copyTextToClipboard('fallback text');

    expect(result).toBe(true);
    expect(execSpy).toHaveBeenCalledWith('copy');
    // The fallback textarea must be cleaned up, not left in the DOM.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('creates a hidden, off-screen, readonly textarea for the fallback path', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    let capturedTextarea: HTMLTextAreaElement | null = null;
    vi.spyOn(document, 'execCommand').mockImplementation(() => {
      capturedTextarea = document.querySelector('textarea');
      return true;
    });

    await copyTextToClipboard('inspect me');

    expect(capturedTextarea).not.toBeNull();
    expect(capturedTextarea!.value).toBe('inspect me');
    expect(capturedTextarea!.getAttribute('readonly')).toBe('');
    expect(capturedTextarea!.style.position).toBe('fixed');
    expect(capturedTextarea!.style.opacity).toBe('0');
  });

  it('returns false and still cleans up the textarea when execCommand throws', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    vi.spyOn(document, 'execCommand').mockImplementation(() => {
      throw new Error('exec failed');
    });

    const result = await copyTextToClipboard('will fail');

    expect(result).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('returns false when execCommand reports it did not copy', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    vi.spyOn(document, 'execCommand').mockReturnValue(false);

    const result = await copyTextToClipboard('nope');

    expect(result).toBe(false);
  });

  it('goes straight to the fallback when navigator.clipboard is unavailable', async () => {
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true);

    try {
      const result = await copyTextToClipboard('no clipboard api');
      expect(result).toBe(true);
      expect(execSpy).toHaveBeenCalledWith('copy');
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
    }
  });
});
