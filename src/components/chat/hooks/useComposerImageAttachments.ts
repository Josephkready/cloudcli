import { useCallback, useState } from 'react';
import type { ClipboardEvent } from 'react';

import { recordFeatureUse } from '../../../utils/featureUsage';
import { MAX_IMAGE_ATTACHMENT_COUNT, partitionImageFiles } from '../utils/imageAttachments';

import { useImageDropzone } from './useImageDropzone';

/**
 * Attached-image state (pending upload) for the composer: the file list
 * itself, per-file upload progress/errors, paste/drop intake, and the
 * file-picker wiring. `uploadingImages`/`setUploadingImages` stay exposed for
 * callers that drive upload progress (currently reset-only, from the send
 * path), matching the previous inline state's shape exactly.
 */
export function useComposerImageAttachments() {
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [uploadingImages, setUploadingImages] = useState<Map<string, number>>(new Map());
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());

  const handleImageFiles = useCallback((files: File[]) => {
    const { validFiles, errors } = partitionImageFiles(files);

    if (errors.length > 0) {
      setImageErrors((previous) => {
        const next = new Map(previous);
        for (const { fileName, message } of errors) {
          next.set(fileName, message);
        }
        return next;
      });
    }

    if (validFiles.length > 0) {
      recordFeatureUse('chat.image_attach');
      setAttachedImages((previous) => [...previous, ...validFiles].slice(0, MAX_IMAGE_ATTACHMENT_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleImageFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleImageFiles(imageFiles);
        }
      }
    },
    [handleImageFiles],
  );

  // Native drag/drop + file picker. `accept`, `maxSize` and `maxFiles` used to
  // be configured on react-dropzone, but `handleImageFiles` already enforces the
  // image type and the 5 MB ceiling, and the attachment list is capped at 5 — so
  // removing the library removed duplication, not validation (#287).
  const { getRootProps, getInputProps, isDragActive, open } = useImageDropzone(handleImageFiles);

  const resetImages = useCallback(() => {
    setAttachedImages([]);
    setUploadingImages(new Map());
    setImageErrors(new Map());
  }, []);

  return {
    attachedImages,
    setAttachedImages,
    uploadingImages,
    setUploadingImages,
    imageErrors,
    setImageErrors,
    handlePaste,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker: open,
    resetImages,
  };
}
