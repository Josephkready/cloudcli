import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_DIMENSION, QUALITY } from './attachments';
import { compressImage } from './compressImage';

/**
 * jsdom ships no real 2D canvas rendering context (there is no `canvas`
 * native module here), so `HTMLCanvasElement.getContext`/`toBlob` and the
 * global `createImageBitmap` are stubbed directly rather than exercised for
 * real. What is asserted is the DECISION each stub is driven with — the
 * computed draw size, the WebP-then-JPEG encode order, and the quality
 * constant — which is exactly what would be wrong if this wiring regressed,
 * independent of what any engine's real decoder/encoder produces.
 */

type FakeBitmap = { width: number; height: number; close: ReturnType<typeof vi.fn> };

function fakeBitmap(width: number, height: number): FakeBitmap {
  return { width, height, close: vi.fn() };
}

function stubCanvas(toBlobImpl: (callback: BlobCallback, type?: string, quality?: number) => void) {
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(toBlobImpl as never);
  return { drawImage };
}

describe('compressImage', () => {
  let createImageBitmap: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createImageBitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', createImageBitmap);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('downscales a large source to the 1600px long edge and encodes WebP at 0.8 quality', async () => {
    createImageBitmap.mockResolvedValue(fakeBitmap(3200, 1800));
    const calls: Array<[string | undefined, number | undefined]> = [];
    const { drawImage } = stubCanvas((callback, type, quality) => {
      calls.push([type, quality]);
      callback(new Blob(['webp-bytes'], { type: 'image/webp' }));
    });

    const file = new File(['source'], 'shot.png', { type: 'image/png' });
    const result = await compressImage(file);

    expect(result.mime).toBe('image/webp');
    expect(result.name).toBe('shot.png');
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1600, 900);
    expect(calls[0]).toEqual(['image/webp', QUALITY]);
    // Only one encode attempt needed — WebP succeeded on the first try.
    expect(calls.length).toBe(1);
  });

  it('never upscales a source already under the cap', async () => {
    createImageBitmap.mockResolvedValue(fakeBitmap(200, 100));
    const { drawImage } = stubCanvas((callback) => callback(new Blob(['x'], { type: 'image/webp' })));

    await compressImage(new File(['x'], 'small.png', { type: 'image/png' }));

    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 200, 100);
  });

  it('falls back to JPEG at the same quality when the engine cannot encode WebP', async () => {
    createImageBitmap.mockResolvedValue(fakeBitmap(800, 600));
    const seen: Array<string | undefined> = [];
    stubCanvas((callback, type, quality) => {
      seen.push(type);
      if (type === 'image/webp') {
        callback(null); // canvas.toBlob resolves null rather than throwing when unsupported
        return;
      }
      expect(quality).toBe(QUALITY);
      callback(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    });

    const result = await compressImage(new File(['x'], 'shot.png', { type: 'image/png' }));

    expect(seen).toEqual(['image/webp', 'image/jpeg']);
    expect(result.mime).toBe('image/jpeg');
  });

  it('rejects a source the browser cannot decode with a clear, human message', async () => {
    createImageBitmap.mockRejectedValue(new Error('unsupported HEIC variant'));

    await expect(compressImage(new File(['x'], 'photo.heic', { type: 'image/heic' }))).rejects.toThrow(
      /format.*support/i,
    );
  });

  it('throws when neither WebP nor JPEG encoding produces a blob', async () => {
    createImageBitmap.mockResolvedValue(fakeBitmap(800, 600));
    stubCanvas((callback) => callback(null));

    await expect(compressImage(new File(['x'], 'shot.png', { type: 'image/png' }))).rejects.toThrow();
  });

  it('reports the compressed blob size, not the original file size', async () => {
    createImageBitmap.mockResolvedValue(fakeBitmap(400, 400));
    const compressedBytes = 'a'.repeat(1234);
    stubCanvas((callback) => callback(new Blob([compressedBytes], { type: 'image/webp' })));

    const original = new File(['x'.repeat(50_000)], 'big.png', { type: 'image/png' });
    const result = await compressImage(original);

    expect(result.size).toBe(compressedBytes.length);
    expect(result.size).toBeLessThan(original.size);
  });

  it('exposes the same MAX_DIMENSION contract attachments.ts advertises', () => {
    expect(MAX_DIMENSION).toBe(1600);
  });
});
