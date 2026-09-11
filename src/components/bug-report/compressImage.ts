/**
 * Bug-report screenshots — client-side compression (dante-config
 * skills/bug-report-button/SKILL.md §9).
 *
 * The only DOM/canvas-touching piece of the attachment pipeline: decode ->
 * downscale -> re-encode, entirely client-side, so an image never reaches the
 * network raw. Split out of {@link ./attachments.ts} (pure decision logic,
 * `node --test`-able) and out of `BugReportDialog.tsx` (wiring) so it can be
 * covered on its own under jsdom with a mocked canvas — jsdom ships no real
 * 2D rendering context, so this is tested by stubbing `createImageBitmap`,
 * `HTMLCanvasElement.getContext`, and `HTMLCanvasElement.toBlob` rather than
 * by decoding a real image.
 */
import { MAX_DIMENSION, QUALITY, rejectionMessage, targetDimensions } from './attachments';

export type CompressedImage = {
  name: string;
  mime: string;
  size: number;
  blob: Blob;
};

/**
 * Decodes `file` off the main thread via `createImageBitmap` (which throws
 * cleanly on a format the browser can't handle — some HEIC variants — which
 * is exactly the "reject with a clear message" case §9 calls for; no HEIC
 * decoder is shipped for this, only the browser's own decoder is consulted),
 * downscales it to {@link MAX_DIMENSION}'s long edge via
 * {@link targetDimensions} (never upscaling a smaller source), and re-encodes
 * via canvas at {@link QUALITY} — WebP first, falling back to JPEG where the
 * engine's `canvas.toBlob` doesn't support WebP encoding (it resolves `null`
 * rather than throwing).
 */
export async function compressImage(file: File): Promise<CompressedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(rejectionMessage('unsupported'));
  }

  const { width, height } = targetDimensions(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close?.();
    throw new Error(rejectionMessage('unsupported'));
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/webp', QUALITY);
  });
  // Not every engine supports WebP encoding — JPEG is the universal fallback.
  const finalBlob =
    blob ??
    (await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', QUALITY);
    }));
  if (!finalBlob) {
    throw new Error(rejectionMessage('unsupported'));
  }

  return {
    name: file.name || 'screenshot',
    mime: finalBlob.type,
    size: finalBlob.size,
    blob: finalBlob,
  };
}
