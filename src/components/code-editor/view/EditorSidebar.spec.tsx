import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';

import type { CodeEditorFile } from '../types/types';

import EditorSidebar from './EditorSidebar';

// CodeEditor pulls in CodeMirror/Monaco machinery that isn't relevant here -
// this spec only cares about the sizing wrapper EditorSidebar renders around it.
vi.mock('./CodeEditor', () => ({
  default: () => <div data-testid="code-editor-stub" />,
}));

// jsdom elements report clientWidth 0, which would make EditorSidebar's own
// "not enough room" effect immediately pop the editor out of the sizing
// wrapper this spec is testing. Report a roomy width instead.
const originalClientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get() {
    return 1200;
  },
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  if (originalClientWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidthDescriptor);
  }
});

const baseFile: CodeEditorFile = {
  path: 'src/index.ts',
  name: 'index.ts',
  content: '',
} as CodeEditorFile;

function renderSidebar(overrides: Partial<Parameters<typeof EditorSidebar>[0]> = {}) {
  const resizeHandleRef = createRef<HTMLDivElement>();
  return render(
    <EditorSidebar
      editingFile={baseFile}
      isMobile={false}
      editorExpanded={false}
      editorWidth={400}
      resizeHandleRef={resizeHandleRef}
      onResizeStart={() => {}}
      onCloseEditor={() => {}}
      onToggleEditorExpand={() => {}}
      {...overrides}
    />,
  );
}

describe('EditorSidebar sizing', () => {
  it('applies the intended flex-shrink-0 class and a min-width/width inline style when not expanded', () => {
    renderSidebar({ editorExpanded: false, editorWidth: 400 });

    const editorNode = screen.getByTestId('code-editor-stub').parentElement as HTMLElement;

    // The dynamic min-width can't be a Tailwind class (Tailwind's JIT scanner
    // can't see a template-literal-built arbitrary value), so it must come
    // from the inline style, and the className must not contain the stray
    // malformed arbitrary-value text that used to live here.
    expect(editorNode.className).toContain('flex-shrink-0');
    expect(editorNode.className).not.toMatch(/min-w-\[/);
    expect(editorNode.style.minWidth).toBe('280px');
    expect(editorNode.style.width).toBe('400px');
  });

  it('uses flex-1/min-w-0 with no inline sizing when expanded', () => {
    renderSidebar({ editorExpanded: true });

    const editorNode = screen.getByTestId('code-editor-stub').parentElement as HTMLElement;

    expect(editorNode.className).toContain('min-w-0');
    expect(editorNode.className).toContain('flex-1');
    expect(editorNode.style.width).toBe('');
    expect(editorNode.style.minWidth).toBe('');
  });
});
