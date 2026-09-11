/**
 * Bug-report screenshots — pure decision logic (dante-config
 * skills/bug-report-button/SKILL.md §9).
 *
 * Every DECISION around staging up to 3 images lives here so it is covered by
 * `npm run test:unit` (`node --test`, no DOM) without a browser: whether a
 * file may be staged, what size a canvas re-encode should downscale to, what
 * to reject and why, and how a paste/drop/file-picker source is turned into a
 * plain list of image `File`s.
 *
 * DOM/canvas work — the actual file input, the `paste` listener, and the
 * canvas draw/encode that turns a raw `File` into a compressed blob — lives in
 * `compressImage.ts` and `BugReportDialog.tsx`; `createImageBitmap`/canvas
 * decode is not something `node --test` can exercise, but nothing here needs
 * it. No DOM or network in this module.
 */

/** Up to 3 images per report, matching the durable queue's own cap. */
export const MAX_ATTACHMENTS = 3;

/** ~2MB hard cap, measured on the COMPRESSED blob, not the original file. */
export const MAX_ATTACHMENT_BYTES = 2_000_000;

/** The long-edge cap a canvas re-encode downscales to — never upscaled. */
export const MAX_DIMENSION = 1600;

/** `canvas.toBlob` quality for both the WebP attempt and the JPEG fallback. */
export const QUALITY = 0.8;

/** One image already staged for a report: compressed, previewed, removable. */
export type StagedAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  blob: Blob;
  previewUrl: string;
};

/** Why a candidate image was refused. */
export type AttachmentRejection = 'too-many' | 'too-large' | 'unsupported';

/** A File-like value: only the two fields any of this module's logic reads. */
type FileLike = { type?: string; name?: string };

/** A source `stageResult` can accept: an already-compressed candidate. */
export type StageCandidate = {
  id?: string;
  name?: string;
  mime?: string;
  size?: number;
  blob?: Blob;
  previewUrl?: string;
};

function isImage(file: unknown): file is FileLike {
  return Boolean(file) && typeof (file as FileLike).type === 'string' && (file as FileLike).type!.startsWith('image/');
}

/**
 * Whether one more image may be staged right now. Checked BEFORE spending any
 * work compressing a file that would just be rejected anyway.
 */
export function canAcceptMore(list: readonly unknown[] | null | undefined): boolean {
  return (Array.isArray(list) ? list.length : 0) < MAX_ATTACHMENTS;
}

/**
 * The dimensions a canvas re-encode should draw at: long edge capped at
 * {@link MAX_DIMENSION}, aspect ratio preserved, integer pixels. A source
 * already at or under the cap on both axes is returned unchanged — this never
 * upscales a smaller image.
 */
export function targetDimensions(width: number, height: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const longEdge = Math.max(w, h);
  if (longEdge <= MAX_DIMENSION) {
    return { width: w, height: h };
  }
  const scale = MAX_DIMENSION / longEdge;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * Every image-typed entry from a clipboard paste, a drag-and-drop, a bare
 * `FileList` (`<input type=file>.files`), or a plain array of File-like
 * objects. Never touches a non-image item — a paste that carries both a
 * screenshot and typed text must still let the text land wherever the
 * browser's default paste behavior puts it; this only ever picks out images
 * to stage, it never intercepts or blocks the paste/drop event itself.
 *
 * `.files` is preferred when present and non-empty: per spec it is already
 * exactly the `.items` entries where `kind === 'file'`, exposed as real File
 * objects, so reading both would double-count. `.items` (walked via
 * `getAsFile()`) is the fallback for a clipboard implementation that
 * populates one but not the other.
 */
export function extractImageEntries(source: unknown): FileLike[] {
  const out: FileLike[] = [];
  const withFiles = source as { files?: ArrayLike<FileLike> } | null | undefined;
  const files = withFiles?.files;
  if (files && typeof files.length === 'number' && files.length > 0) {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (isImage(file)) out.push(file);
    }
    return out;
  }

  const withItems = source as
    | { items?: ArrayLike<{ kind?: string; type?: string; getAsFile?: () => FileLike | null }> }
    | null
    | undefined;
  const items = withItems?.items;
  if (items && typeof items.length === 'number') {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item && item.kind === 'file' && typeof item.type === 'string' && item.type.startsWith('image/')) {
        const file = typeof item.getAsFile === 'function' ? item.getAsFile() : (item as unknown as FileLike);
        if (file) out.push(file);
      }
    }
    return out;
  }

  // A bare FileList/array of File-like objects passed directly (no wrapping
  // .items/.files) — the file-picker's own `input.files` shape.
  const asArrayLike = source as ArrayLike<FileLike> | null | undefined;
  if (asArrayLike && typeof asArrayLike.length === 'number') {
    for (let i = 0; i < asArrayLike.length; i += 1) {
      const file = asArrayLike[i];
      if (isImage(file)) out.push(file);
    }
  }
  return out;
}

/** A short random id for a staged attachment, when the caller doesn't supply one. */
export function makeId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Stage one ALREADY-COMPRESSED candidate. Two independent refusals, and only
 * one caller-visible reason at a time:
 *   - `'too-many'`  — the count cap (checked first: a full tray shouldn't
 *     blame the file's size).
 *   - `'too-large'` — the compressed blob is still over
 *     {@link MAX_ATTACHMENT_BYTES} (a pathological source image) — checked on
 *     the real byte count, not the original file's size.
 *
 * Returns `{ list, rejected }`; `list` is the unchanged input on any refusal.
 */
export function stageResult(
  list: readonly StagedAttachment[] | null | undefined,
  entry: StageCandidate,
): { list: StagedAttachment[]; rejected: AttachmentRejection | null } {
  const items = Array.isArray(list) ? [...list] : [];
  if (!canAcceptMore(items)) {
    return { list: items, rejected: 'too-many' };
  }
  const size = typeof entry.size === 'number' ? entry.size : 0;
  if (size > MAX_ATTACHMENT_BYTES) {
    return { list: items, rejected: 'too-large' };
  }
  const staged: StagedAttachment = {
    id: entry.id || makeId(),
    name: entry.name || 'screenshot',
    mime: entry.mime || 'image/jpeg',
    size,
    blob: entry.blob as Blob,
    previewUrl: entry.previewUrl || '',
  };
  return { list: [...items, staged], rejected: null };
}

/**
 * Drop exactly one staged image. Never touches anything else — the typed
 * description and the rest of the tray are unaffected.
 */
export function removeStaged(
  list: readonly StagedAttachment[] | null | undefined,
  id: string,
): StagedAttachment[] {
  return (Array.isArray(list) ? list : []).filter((item) => item && item.id !== id);
}

/**
 * The one-line notice shown once >=1 image is staged. A screenshot is not run
 * through {@link ../buildBugReportMetadata.ts}'s allowlist/sanitizer — it is
 * whatever was on screen when it was taken.
 */
export function privacyNotice(): string {
  return 'Screenshots may show more of your screen than the details above — check before sending.';
}

/**
 * A short, human reason for each rejection code above, for the inline hint
 * near the attach control. Never sent to the server.
 */
export function rejectionMessage(code: AttachmentRejection | string): string {
  if (code === 'too-many') return `Up to ${MAX_ATTACHMENTS} screenshots per report.`;
  if (code === 'too-large') return 'Image too large even after compression.';
  if (code === 'unsupported') {
    return "This image format isn't supported — try again or choose a JPEG/PNG.";
  }
  return '';
}
