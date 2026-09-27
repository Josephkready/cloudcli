/**
 * Pure validation for image files dropped/pasted/picked into the composer.
 * Extracted from `useChatComposerState`'s `handleImageFiles` so the
 * type/size rules are unit-testable without a DOM `File` constructor quirks
 * or React state.
 */

export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_COUNT = 5;

export type ImageAttachmentError = {
  fileName: string;
  message: string;
};

export type PartitionedImageFiles<TFile> = {
  validFiles: TFile[];
  errors: ImageAttachmentError[];
};

type AttachableFile = {
  type?: string;
  size?: number;
  name?: string;
};

/**
 * Splits candidate files into ones that pass the attachment rules (real
 * image type, under the size ceiling) and the ones rejected with a reason.
 * Anything not shaped like a `File` (null, wrong type) is silently dropped
 * rather than surfaced as an error, matching the original inline behavior.
 */
export function partitionImageFiles<TFile extends AttachableFile>(
  files: TFile[],
): PartitionedImageFiles<TFile> {
  const validFiles: TFile[] = [];
  const errors: ImageAttachmentError[] = [];

  for (const file of files) {
    if (!file || typeof file !== 'object') {
      continue;
    }
    if (!file.type || !file.type.startsWith('image/')) {
      continue;
    }
    if (!file.size || file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      errors.push({ fileName: file.name || 'Unknown file', message: 'File too large (max 5MB)' });
      continue;
    }
    validFiles.push(file);
  }

  return { validFiles, errors };
}
