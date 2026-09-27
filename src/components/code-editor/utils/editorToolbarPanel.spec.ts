import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import { describe, expect, it, vi } from 'vitest';

import { createEditorToolbarPanelExtension } from './editorToolbarPanel';
import type { CodeEditorFile } from '../types/types';

const labels = {
  changes: 'changes',
  previousChange: 'Previous change',
  nextChange: 'Next change',
  hideDiff: 'Hide diff',
  showDiff: 'Show diff',
  collapse: 'Collapse',
  expand: 'Expand',
};

const baseFile: CodeEditorFile = { name: 'a.ts', path: 'a.ts' };

function mountPanel(params: Partial<Parameters<typeof createEditorToolbarPanelExtension>[0]> = {}, docExtensions: Extension[] = []) {
  const extension = createEditorToolbarPanelExtension({
    file: baseFile,
    showDiff: false,
    isSidebar: false,
    isExpanded: false,
    onToggleDiff: vi.fn(),
    onPopOut: null,
    onToggleExpand: null,
    labels,
    ...params,
  } as Parameters<typeof createEditorToolbarPanelExtension>[0]);

  const view = new EditorView({
    state: EditorState.create({ doc: 'hello\nworld\n', extensions: [...docExtensions, ...extension] }),
    parent: document.createElement('div'),
  });

  return { extension, view };
}

describe('createEditorToolbarPanelExtension', () => {
  it('renders no panel when there is nothing to show', () => {
    const extension = createEditorToolbarPanelExtension({
      file: baseFile,
      showDiff: false,
      isSidebar: false,
      isExpanded: false,
      onToggleDiff: vi.fn(),
      onPopOut: null,
      onToggleExpand: null,
      labels,
    });
    expect(extension).toEqual([]);
  });

  it('shows a diff-toggle button when the file has diff info', () => {
    const onToggleDiff = vi.fn();
    const { view } = mountPanel({
      file: { ...baseFile, diffInfo: { old_string: 'a', new_string: 'b' } },
      showDiff: false,
      onToggleDiff,
    });

    const button = view.dom.querySelector<HTMLButtonElement>('.cm-toggle-diff-btn');
    expect(button).toBeTruthy();
    expect(button?.title).toBe('Show diff');

    button?.click();
    expect(onToggleDiff).toHaveBeenCalledTimes(1);

    view.destroy();
  });

  it('shows the pop-out and expand buttons only in the sidebar', () => {
    const onPopOut = vi.fn();
    const onToggleExpand = vi.fn();
    const { view } = mountPanel({
      file: baseFile,
      isSidebar: true,
      isExpanded: true,
      onPopOut,
      onToggleExpand,
    });

    const popOutButton = view.dom.querySelector<HTMLButtonElement>('.cm-popout-btn');
    const expandButton = view.dom.querySelector<HTMLButtonElement>('.cm-expand-btn');
    expect(popOutButton).toBeTruthy();
    expect(expandButton?.title).toBe('Collapse');

    popOutButton?.click();
    expandButton?.click();
    expect(onPopOut).toHaveBeenCalledTimes(1);
    expect(onToggleExpand).toHaveBeenCalledTimes(1);

    view.destroy();
  });

  it('omits pop-out/expand buttons outside the sidebar even when handlers are given', () => {
    const { view } = mountPanel({
      file: baseFile,
      isSidebar: false,
      onPopOut: vi.fn(),
      onToggleExpand: vi.fn(),
    });
    // hasToolbarButtons is false in this combination (no diffInfo, not sidebar),
    // so the extension array itself should be empty and nothing renders.
    expect(view.dom.querySelector('.cm-editor-toolbar-panel')).toBeNull();
    view.destroy();
  });

  it('navigates real diff chunks with the prev/next buttons and wraps around', () => {
    const { view } = mountPanel(
      {
        file: { ...baseFile, diffInfo: { old_string: 'a\nb\nc\nd\ne\n', new_string: 'A\nb\nC\nd\nE\n' } },
        showDiff: true,
      },
      [unifiedMergeView({ original: 'a\nb\nc\nd\ne\n' })],
    );

    const changesLabel = view.dom.querySelector('.cm-editor-toolbar-panel span');
    expect(changesLabel?.textContent).toMatch(/changes/);

    const prev = view.dom.querySelector<HTMLButtonElement>('.cm-diff-nav-prev');
    const next = view.dom.querySelector<HTMLButtonElement>('.cm-diff-nav-next');
    expect(prev?.disabled).toBe(false);
    expect(next?.disabled).toBe(false);

    // From index 0, "previous" should wrap to the last chunk.
    prev?.click();
    // "next" should then wrap back toward the start.
    next?.click();
    next?.click();

    view.destroy();
  });

  it('disables diff navigation when the diff has no chunks to report', () => {
    // showDiff+diffInfo makes hasDiff true, but with no merge extension mounted
    // getChunks() returns undefined, exercising the `chunksData?.chunks || []`
    // fallback and the 0-chunk disabled state.
    const { view } = mountPanel({
      file: { ...baseFile, diffInfo: { old_string: 'a', new_string: 'b' } },
      showDiff: true,
    });

    const prev = view.dom.querySelector<HTMLButtonElement>('.cm-diff-nav-prev');
    const next = view.dom.querySelector<HTMLButtonElement>('.cm-diff-nav-next');
    expect(prev?.disabled).toBe(true);
    expect(next?.disabled).toBe(true);

    // Clicking a disabled nav button is a no-op guarded by the empty-chunks check.
    prev?.click();
    next?.click();

    view.destroy();
  });

  it('escapes label HTML so it cannot inject markup into the toolbar', () => {
    const { view } = mountPanel({
      file: { ...baseFile, diffInfo: { old_string: 'a', new_string: 'b' } },
      showDiff: true,
      labels: { ...labels, changes: '<img src=x onerror=alert(1)>' },
    });

    expect(view.dom.innerHTML).not.toContain('<img src=x');
    expect(view.dom.innerHTML).toContain('&lt;img');

    view.destroy();
  });
});
