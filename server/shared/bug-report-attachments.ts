/**
 * Pure server-side validation for bug-report screenshot attachments (dante-config
 * skills/bug-report-button/SKILL.md §9).
 *
 * Every client-side cap is advisory; this module re-derives count, size, and
 * type from what actually arrived — content is SNIFFED from the bytes, never
 * trusted from the browser's declared MIME type or the upload's filename
 * extension. Kept separate from `server/shared/bug-report.ts` (title/body/
 * metadata) because this half of the contract has nothing to do with issue
 * text — it is the same "content, not just credentials" boundary the rest of
 * this feature draws between the allowlisted metadata block and user-attached
 * binary content.
 */
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/** Up to 3 images per report, matching the durable queue's own cap. */
export const MAX_ATTACHMENTS = 3;

/** ~2MB hard cap, measured on received bytes, never a claimed Content-Length. */
export const MAX_ATTACHMENT_BYTES = 2_000_000;

/** One validated attachment, ready to hand to the queue adapter. */
export type PreparedAttachment = {
  name: string;
  mime: string;
  bytes: Buffer;
};

/** The minimal shape this module needs from a multer-parsed upload. */
export type RawUpload = {
  buffer: Buffer;
  originalname: string;
};

const MIME_SNIFFERS: ReadonlyArray<readonly [string, Buffer]> = [
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/gif', Buffer.from('GIF87a', 'ascii')],
  ['image/gif', Buffer.from('GIF89a', 'ascii')],
];

/** The content's real image type, or `null` if it matches none of the allowed formats. */
export function sniffImageMime(data: Buffer): string | null {
  for (const [mime, magic] of MIME_SNIFFERS) {
    if (data.length >= magic.length && data.subarray(0, magic.length).equals(magic)) {
      return mime;
    }
  }
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * A filename safe to use as a temp-file name and as Markdown alt text —
 * basename only, unsafe characters replaced, never empty, and never
 * containing a `..` run.
 *
 * Stripping/replacing `/` and `\` already makes an internal `..` harmless on
 * its own (there is no separator left for it to traverse across), but
 * collapsing repeated dots too means the "cannot contain .. sequences"
 * invariant holds literally, not just "isn't exploitable today".
 */
export function sanitizeAttachmentName(name: string, fallback = 'screenshot'): string {
  const base = path.basename(String(name || ''));
  let cleaned = base.replace(/[^A-Za-z0-9._-]/g, '-');
  cleaned = cleaned.replace(/\.{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned ? cleaned.slice(0, 150) : fallback;
}

/**
 * Validates raw upload bytes into the adapter's `[{name, mime, bytes}, ...]`
 * shape. Every check is independent of the client's claims — count, size, and
 * content type are the standard's server-side re-validation (§9), not a
 * courtesy re-run of what the browser already checked.
 *
 * Throws `AppError` with the status code the route should return: 413 for a
 * count/size violation, 415 for content that doesn't sniff as an allowed
 * image type.
 */
export function prepareAttachments(uploads: RawUpload[]): PreparedAttachment[] {
  if (uploads.length > MAX_ATTACHMENTS) {
    throw new AppError(`Up to ${MAX_ATTACHMENTS} screenshots are allowed per report.`, {
      code: 'BUG_REPORT_ATTACHMENT_COUNT',
      statusCode: 413,
    });
  }

  return uploads.map(({ buffer, originalname }) => {
    if (!buffer || buffer.length === 0) {
      throw new AppError('An attached image was empty.', {
        code: 'BUG_REPORT_ATTACHMENT_TYPE',
        statusCode: 415,
      });
    }
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new AppError('An attached image was too large.', {
        code: 'BUG_REPORT_ATTACHMENT_TOO_LARGE',
        statusCode: 413,
      });
    }
    const mime = sniffImageMime(buffer);
    if (!mime) {
      throw new AppError('An attached file was not a recognized image type.', {
        code: 'BUG_REPORT_ATTACHMENT_TYPE',
        statusCode: 415,
      });
    }
    return { name: sanitizeAttachmentName(originalname), mime, bytes: buffer };
  });
}
