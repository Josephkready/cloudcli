import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, FormEvent, MouseEvent, MutableRefObject, SetStateAction } from 'react';

interface UseComposerTextareaArgs {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  inputValueRef: MutableRefObject<string>;
  resetCommandMenuState: () => void;
  setCursorPosition: (pos: number) => void;
  /**
   * Shared with `useSlashCommands`/`useFileMentions`/`useQueuedDrafts`, which
   * all need the same DOM node — so the ref is created once by the caller and
   * threaded through, not created here.
   */
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
}

/**
 * Textarea sizing/scroll-sync and the plain (non-mention, non-command)
 * input chrome: autosize, the highlight-overlay scroll mirror, and clearing
 * the composer back to empty.
 */
export function useComposerTextarea({
  input,
  setInput,
  inputValueRef,
  resetCommandMenuState,
  setCursorPosition,
  textareaRef,
}: UseComposerTextareaArgs) {
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);

  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea, textareaRef]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input, textareaRef]);

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState, setInput, inputValueRef, textareaRef]);

  return {
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    resizeTextarea,
    syncInputOverlayScroll,
    handleTextareaClick,
    handleTextareaInput,
    handleClearInput,
  };
}
