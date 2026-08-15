import { useCallback, useRef, useState } from 'react';

/**
 * Native drag-and-drop + file-picker wiring for composer image attachments,
 * replacing `react-dropzone` (#287).
 *
 * WHY NOT JUST LAZY-LOAD react-dropzone
 *   It was ~60 KB of the entry chunk, but deferring it is awkward rather than
 *   cheap: `getRootProps`/`getInputProps` are spread onto the composer at FIRST
 *   render and `open()` backs the attach button, so a demand-load needs a
 *   boundary handing back inert props until the module lands. Reimplementing the
 *   parts actually used is smaller than that boundary, and removes the
 *   dependency outright.
 *
 * WHAT WAS ACTUALLY BEING USED
 *   `accept`, `maxSize` and `maxFiles` were all configured on the dropzone, but
 *   every one of them is already enforced downstream: the drop handler filters
 *   on `type.startsWith('image/')` and a 5 MB ceiling, and the attachment list
 *   is `slice(0, 5)`d. They were belt-and-braces, not the only guard, so
 *   dropping the library does not drop the validation. What genuinely mattered
 *   was: drag affordance, drop, and a programmatic file picker.
 *
 * WHAT IS DELIBERATELY DIFFERENT
 *   `react-dropzone` rejects a whole drop when a file fails `accept`/`maxSize`.
 *   Here every dropped file is handed to the caller, which filters per file and
 *   surfaces a per-file error — so dropping one oversized image alongside three
 *   valid ones now attaches the three instead of silently discarding all four.
 */

type DragEventLike = {
  preventDefault: () => void;
  stopPropagation: () => void;
  dataTransfer?: { types?: readonly string[] | string[]; files?: FileList | null } | null;
};

/**
 * True when the drag actually carries files. Without this the overlay also
 * appears for a text selection dragged over the composer, which promises a drop
 * target that would do nothing.
 */
function dragCarriesFiles(event: DragEventLike): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes('Files') : false;
}

export type ImageDropzone = {
  getRootProps: () => Record<string, unknown>;
  getInputProps: () => Record<string, unknown>;
  isDragActive: boolean;
  /** Opens the OS file picker — backs the composer's attach button. */
  open: () => void;
};

export function useImageDropzone(onFiles: (files: File[]) => void): ImageDropzone {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  /**
   * Depth counter, not a boolean: dragging across a child element fires
   * `dragleave` on the parent before `dragenter` on the child, so a boolean
   * flickers the overlay off and on as the pointer moves over the composer's
   * inner nodes.
   */
  const dragDepth = useRef(0);

  const handleDragEnter = useCallback((event: DragEventLike) => {
    if (!dragCarriesFiles(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current += 1;
    setIsDragActive(true);
  }, []);

  const handleDragOver = useCallback((event: DragEventLike) => {
    if (!dragCarriesFiles(event)) {
      return;
    }
    // Required: without preventDefault on dragover the browser refuses the drop
    // and opens the file in the tab instead.
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((event: DragEventLike) => {
    if (!dragCarriesFiles(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setIsDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: DragEventLike) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current = 0;
      setIsDragActive(false);

      const files = event.dataTransfer?.files;
      if (files && files.length > 0) {
        onFiles(Array.from(files));
      }
    },
    [onFiles],
  );

  const handleChange = useCallback(
    (event: { target: HTMLInputElement }) => {
      const files = event.target.files;
      if (files && files.length > 0) {
        onFiles(Array.from(files));
      }
      // Reset so picking the SAME file twice in a row still fires `change` —
      // the browser suppresses it when the value is unchanged.
      event.target.value = '';
    },
    [onFiles],
  );

  const getRootProps = useCallback(
    () => ({
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    }),
    [handleDragEnter, handleDragOver, handleDragLeave, handleDrop],
  );

  const getInputProps = useCallback(
    () => ({
      ref: inputRef,
      type: 'file' as const,
      accept: 'image/*',
      multiple: true,
      // Hidden rather than unrendered: `open()` clicks this node, and the
      // picker cannot be opened from a detached input.
      style: { display: 'none' } as const,
      tabIndex: -1,
      onChange: handleChange,
    }),
    [handleChange],
  );

  const open = useCallback(() => {
    inputRef.current?.click();
  }, []);

  return { getRootProps, getInputProps, isDragActive, open };
}
