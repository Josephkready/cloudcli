import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useImageDropzone } from './useImageDropzone';

/**
 * #287 replaced react-dropzone with this hook to get ~60 KB out of the entry
 * chunk. These pin the behaviour that was previously the library's job, so
 * "attach an image" cannot quietly regress into a dead drop target.
 */

function fileList(files: File[]): FileList {
  const list: Record<string | number, unknown> = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
  };
  files.forEach((file, index) => {
    list[index] = file;
  });
  return list as unknown as FileList;
}

const dragEvent = (types: string[], files: File[] = []) => ({
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  dataTransfer: { types, files: fileList(files) },
});

const png = (name = 'a.png') => new File(['x'], name, { type: 'image/png' });

// `getRootProps`/`getInputProps` are typed as opaque prop bags (they get spread
// onto DOM nodes), so the tests name the handlers they drive.
type RootHandlers = Record<
  'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop',
  (event: unknown) => void
>;
type InputHandlers = {
  onChange: (event: unknown) => void;
  ref: { current: { click: () => void } | null };
  type: string;
  accept: string;
  multiple: boolean;
  style: Record<string, string>;
};

function setup() {
  const onFiles = vi.fn();
  const rendered = renderHook(() => useImageDropzone(onFiles));
  const root = () => rendered.result.current.getRootProps() as unknown as RootHandlers;
  const inputProps = () => rendered.result.current.getInputProps() as unknown as InputHandlers;
  const isDragActive = () => rendered.result.current.isDragActive;
  const open = () => rendered.result.current.open();
  return { onFiles, root, inputProps, isDragActive, open };
}

describe('useImageDropzone — drag affordance', () => {
  it('activates when the drag carries files', () => {
    const { root, isDragActive } = setup();
    expect(isDragActive()).toBe(false);

    act(() => root().onDragEnter(dragEvent(['Files'])));

    expect(isDragActive()).toBe(true);
  });

  it('ignores a drag that carries no files', () => {
    // Dragging selected text over the composer would otherwise be
    // indistinguishable from dragging an image, promising a drop target that
    // does nothing.
    const { root, isDragActive } = setup();

    act(() => root().onDragEnter(dragEvent(['text/plain'])));

    expect(isDragActive()).toBe(false);
  });

  // The composer has nested children, and the browser fires dragleave on the
  // parent BEFORE dragenter on the child. A boolean flag flickers the overlay
  // as the pointer crosses them; the depth counter is what stops that.
  it('stays active while the pointer moves across nested children', () => {
    const { root, isDragActive } = setup();

    act(() => {
      root().onDragEnter(dragEvent(['Files']));
      root().onDragEnter(dragEvent(['Files']));
      root().onDragLeave(dragEvent(['Files']));
    });
    expect(isDragActive()).toBe(true);

    act(() => root().onDragLeave(dragEvent(['Files'])));
    expect(isDragActive()).toBe(false);
  });

  it('never drives the depth counter negative', () => {
    // A stray dragleave with no matching enter would otherwise leave the
    // counter at -1, so the NEXT real drag would need two enters to show the
    // overlay.
    const { root, isDragActive } = setup();

    act(() => root().onDragLeave(dragEvent(['Files'])));
    act(() => root().onDragEnter(dragEvent(['Files'])));

    expect(isDragActive()).toBe(true);
  });

  it('calls preventDefault on dragover, or the browser refuses the drop', () => {
    // Without this the browser opens the dropped file in the tab instead.
    const { root } = setup();
    const event = dragEvent(['Files']);

    act(() => root().onDragOver(event));

    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('useImageDropzone — dropping', () => {
  it('hands every dropped file to the caller and clears the affordance', () => {
    const { onFiles, root, isDragActive } = setup();
    const files = [png('one.png'), png('two.png')];

    act(() => root().onDragEnter(dragEvent(['Files'])));
    act(() => root().onDrop(dragEvent(['Files'], files)));

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0].map((file: File) => file.name)).toEqual(['one.png', 'two.png']);
    expect(isDragActive()).toBe(false);
  });

  it('does not call back on an empty drop', () => {
    const { onFiles, root } = setup();

    act(() => root().onDrop(dragEvent(['Files'], [])));

    expect(onFiles).not.toHaveBeenCalled();
  });

  it('clears the affordance even when the drop carried nothing', () => {
    const { root, isDragActive } = setup();

    act(() => root().onDragEnter(dragEvent(['Files'])));
    act(() => root().onDrop(dragEvent(['Files'], [])));

    expect(isDragActive()).toBe(false);
  });
});

describe('useImageDropzone — the file picker', () => {
  it('exposes a hidden, image-only, multiple file input', () => {
    const { inputProps } = setup();
    const props = inputProps();

    expect(props.type).toBe('file');
    expect(props.accept).toBe('image/*');
    expect(props.multiple).toBe(true);
    // Hidden rather than unrendered: open() clicks this node, and a detached
    // input cannot open the picker.
    expect(props.style).toEqual({ display: 'none' });
  });

  it('hands picked files to the caller', () => {
    const { onFiles, inputProps } = setup();
    const node = { files: fileList([png('picked.png')]), value: 'C:\\fakepath\\picked.png' };

    act(() => inputProps().onChange({ target: node }));

    expect(onFiles.mock.calls[0][0].map((file: File) => file.name)).toEqual(['picked.png']);
  });

  it('resets the input so the same file can be picked twice', () => {
    // The browser suppresses `change` when the value is unchanged, so attaching
    // the same screenshot twice in a row would silently do nothing.
    const { inputProps } = setup();
    const node = { files: fileList([png()]), value: 'C:\\fakepath\\a.png' };

    act(() => inputProps().onChange({ target: node }));

    expect(node.value).toBe('');
  });

  it('open() clicks the input, which is what the attach button needs', () => {
    const { inputProps, open } = setup();
    const click = vi.fn();
    // Mimic React attaching the ref to a real node.
    inputProps().ref.current = { click };

    act(() => open());

    expect(click).toHaveBeenCalledTimes(1);
  });

  it('open() is a no-op before the input mounts, rather than throwing', () => {
    const { open } = setup();

    expect(() => act(() => open())).not.toThrow();
  });
});
