import { act, renderHook } from '@testing-library/react';
import type { FormEvent, MouseEvent } from 'react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useComposerTextarea } from './useComposerTextarea';

function setup(initialInput = '') {
  const setInput = vi.fn();
  const inputValueRef = { current: initialInput };
  const resetCommandMenuState = vi.fn();
  const setCursorPosition = vi.fn();

  const { result, rerender } = renderHook(
    ({ input }: { input: string }) => {
      const textareaRef = useRef<HTMLTextAreaElement | null>(null);
      const hook = useComposerTextarea({
        input,
        setInput,
        inputValueRef,
        resetCommandMenuState,
        setCursorPosition,
        textareaRef,
      });
      // Attach a real (detached) textarea node so the hook's effects can call
      // window.getComputedStyle on it, mirroring what JSX ref-binding would
      // do. scrollHeight is a jsdom-readonly getter, so it's overridden below.
      if (!textareaRef.current) {
        const node = document.createElement('textarea');
        Object.defineProperty(node, 'scrollHeight', { value: 20, configurable: true, writable: true });
        node.focus = vi.fn();
        textareaRef.current = node;
      }
      textareaRef.current.value = input;
      return { hook, textareaRef };
    },
    { initialProps: { input: initialInput } },
  );

  return { result, rerender, setInput, inputValueRef, resetCommandMenuState, setCursorPosition };
}

function inputEvent(target: Partial<HTMLTextAreaElement>) {
  return { currentTarget: target } as unknown as FormEvent<HTMLTextAreaElement>;
}

describe('useComposerTextarea — expansion threshold', () => {
  it('stays collapsed while the content fits within two line-heights', () => {
    const { result } = setup();
    const node = result.current.textareaRef.current as HTMLTextAreaElement;
    // lineHeight defaults to 24 when getComputedStyle isn't wired up in jsdom,
    // so the threshold is 48px — this scrollHeight sits under it.
    Object.assign(node, { scrollHeight: 40 });

    act(() => {
      result.current.hook.handleTextareaInput(inputEvent(node));
    });

    expect(result.current.hook.isTextareaExpanded).toBe(false);
  });

  it('flips to expanded once scrollHeight crosses the two-line-height threshold', () => {
    const { result } = setup();
    const node = result.current.textareaRef.current as HTMLTextAreaElement;
    Object.assign(node, { scrollHeight: 100 });

    act(() => {
      result.current.hook.handleTextareaInput(inputEvent(node));
    });

    expect(result.current.hook.isTextareaExpanded).toBe(true);
  });

  it('collapses back once the content shrinks under the threshold', () => {
    const { result } = setup();
    const node = result.current.textareaRef.current as HTMLTextAreaElement;
    Object.assign(node, { scrollHeight: 100 });
    act(() => {
      result.current.hook.handleTextareaInput(inputEvent(node));
    });
    expect(result.current.hook.isTextareaExpanded).toBe(true);

    Object.assign(node, { scrollHeight: 30 });
    act(() => {
      result.current.hook.handleTextareaInput(inputEvent(node));
    });

    expect(result.current.hook.isTextareaExpanded).toBe(false);
  });

  it('forces collapse once the input becomes empty/whitespace-only', () => {
    const { result, rerender } = setup('some text');
    const node = result.current.textareaRef.current as HTMLTextAreaElement;
    Object.assign(node, { scrollHeight: 100 });
    act(() => {
      result.current.hook.handleTextareaInput(inputEvent(node));
    });
    expect(result.current.hook.isTextareaExpanded).toBe(true);

    rerender({ input: '   ' });

    expect(result.current.hook.isTextareaExpanded).toBe(false);
  });
});

describe('useComposerTextarea — cursor and scroll tracking', () => {
  it('reports the cursor position on click', () => {
    const { result, setCursorPosition } = setup('hello world');
    const node = result.current.textareaRef.current as HTMLTextAreaElement;
    // selectionStart is clamped to the node's own text length, so the node
    // needs matching content before it can report a mid-string cursor.
    node.value = 'hello world';
    node.selectionStart = 7;

    act(() => {
      result.current.hook.handleTextareaClick({ currentTarget: node } as unknown as MouseEvent<HTMLTextAreaElement>);
    });

    expect(setCursorPosition).toHaveBeenCalledWith(7);
  });

  it('reports the cursor position while typing', () => {
    const { result, setCursorPosition } = setup('abcdef');
    const node = result.current.textareaRef.current as HTMLTextAreaElement;
    node.value = 'abcdef';
    node.selectionStart = 3;

    act(() => {
      result.current.hook.handleTextareaInput(inputEvent(node));
    });

    expect(setCursorPosition).toHaveBeenCalledWith(3);
  });
});

describe('useComposerTextarea — clearing', () => {
  it('clears the input state, ref, and command menu, and collapses the box', () => {
    const { result, setInput, inputValueRef, resetCommandMenuState } = setup('draft text');
    const node = result.current.textareaRef.current as HTMLTextAreaElement;
    Object.assign(node, { scrollHeight: 100 });
    act(() => {
      result.current.hook.handleTextareaInput(inputEvent(node));
    });
    expect(result.current.hook.isTextareaExpanded).toBe(true);

    act(() => {
      result.current.hook.handleClearInput();
    });

    expect(setInput).toHaveBeenCalledWith('');
    expect(inputValueRef.current).toBe('');
    expect(resetCommandMenuState).toHaveBeenCalledTimes(1);
    expect(result.current.hook.isTextareaExpanded).toBe(false);
  });

  it('focuses the textarea node when clearing', () => {
    const { result } = setup('draft text');
    const node = result.current.textareaRef.current as HTMLTextAreaElement;

    act(() => {
      result.current.hook.handleClearInput();
    });

    expect(node.focus).toHaveBeenCalledTimes(1);
  });
});
