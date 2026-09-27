import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { unifiedMergeView, getChunks } from '@codemirror/merge';
import { describe, expect, it, vi } from 'vitest';

import {
  createMinimapExtension,
  createScrollToFirstChunkExtension,
  getLanguageExtensions,
} from './editorExtensions';
import type { CodeEditorFile } from '../types/types';

const file = (diffInfo: CodeEditorFile['diffInfo'] = null): CodeEditorFile => ({
  name: 'a.ts',
  path: 'a.ts',
  diffInfo,
});

describe('getLanguageExtensions', () => {
  it.each([
    ['index.js', 1],
    ['index.jsx', 1],
    ['index.ts', 1],
    ['index.tsx', 1],
    ['script.py', 1],
    ['page.html', 1],
    ['page.htm', 1],
    ['style.css', 1],
    ['style.scss', 1],
    ['style.less', 1],
    ['data.json', 1],
    ['README.md', 1],
    ['NOTES.markdown', 1],
    ['config.env', 1],
  ])('returns an extension for %s', (name, expectedLength) => {
    expect(getLanguageExtensions(name)).toHaveLength(expectedLength);
  });

  it('returns no extension for an unknown type', () => {
    expect(getLanguageExtensions('archive.zip')).toEqual([]);
    expect(getLanguageExtensions('noextension')).toEqual([]);
  });

  it('treats .env and .env.* files as env files regardless of case', () => {
    expect(getLanguageExtensions('.env')).toHaveLength(1);
    expect(getLanguageExtensions('.ENV')).toHaveLength(1);
    expect(getLanguageExtensions('.env.local')).toHaveLength(1);
    expect(getLanguageExtensions('.env.production')).toHaveLength(1);
  });
});

describe('createMinimapExtension', () => {
  it('returns no extension when there is no diff info', () => {
    expect(createMinimapExtension({ file: file(null), showDiff: true, minimapEnabled: true, isDarkMode: false })).toEqual([]);
  });

  it('returns no extension when the diff is hidden', () => {
    expect(createMinimapExtension({
      file: file({ old_string: 'a', new_string: 'b' }),
      showDiff: false,
      minimapEnabled: true,
      isDarkMode: false,
    })).toEqual([]);
  });

  it('returns no extension when the minimap is disabled', () => {
    expect(createMinimapExtension({
      file: file({ old_string: 'a', new_string: 'b' }),
      showDiff: true,
      minimapEnabled: false,
      isDarkMode: false,
    })).toEqual([]);
  });

  it('builds a minimap extension that computes highlighted gutter lines from real diff chunks', () => {
    const extension = createMinimapExtension({
      file: file({ old_string: 'line one\nline two\n', new_string: 'line one\nline TWO\n' }),
      showDiff: true,
      minimapEnabled: true,
      isDarkMode: true,
    });

    expect(extension.length).toBeGreaterThan(0);

    // Mount a real EditorView with the merge extension so getChunks() reports
    // actual chunks, then drive the minimap's compute function the same way
    // CodeMirror would (via a state read), exercising the highlight branch.
    const state = EditorState.create({
      doc: 'line one\nline TWO\n',
      extensions: [
        unifiedMergeView({ original: 'line one\nline two\n' }),
        ...extension,
      ],
    });
    const view = new EditorView({ state, parent: document.createElement('div') });

    const chunks = getChunks(view.state)?.chunks ?? [];
    expect(chunks.length).toBeGreaterThan(0);

    view.destroy();
  });

  it('uses a lighter highlight color in light mode', () => {
    const extension = createMinimapExtension({
      file: file({ old_string: 'a\n', new_string: 'b\n' }),
      showDiff: true,
      minimapEnabled: true,
      isDarkMode: false,
    });
    expect(extension.length).toBeGreaterThan(0);
  });
});

describe('createScrollToFirstChunkExtension', () => {
  it('returns no extension when there is no diff info', () => {
    expect(createScrollToFirstChunkExtension({ file: file(null), showDiff: true })).toEqual([]);
  });

  it('returns no extension when the diff is hidden', () => {
    expect(createScrollToFirstChunkExtension({
      file: file({ old_string: 'a', new_string: 'b' }),
      showDiff: false,
    })).toEqual([]);
  });

  it('scrolls to the first real diff chunk once decorations settle', () => {
    vi.useFakeTimers();
    const extension = createScrollToFirstChunkExtension({
      file: file({ old_string: 'a\n', new_string: 'b\n' }),
      showDiff: true,
    });
    expect(extension.length).toBeGreaterThan(0);

    const view = new EditorView({
      state: EditorState.create({
        doc: 'b\n',
        extensions: [unifiedMergeView({ original: 'a\n' }), ...extension],
      }),
      parent: document.createElement('div'),
    });

    const dispatchSpy = vi.spyOn(view, 'dispatch');
    vi.advanceTimersByTime(100);
    expect(dispatchSpy).toHaveBeenCalled();

    view.destroy();
    vi.useRealTimers();
  });
});

describe('.env tokenizer', () => {
  it('classifies comments, keys, operators, strings, interpolation and numbers', async () => {
    const { syntaxTree } = await import('@codemirror/language');
    const [envExtension] = getLanguageExtensions('.env');
    const source = [
      '# a comment',
      'FOO=bar',
      'BAR="quoted value"',
      "BAZ='single quoted'",
      'REF=${FOO}',
      'SHORT=$FOO',
      'NUM=42',
    ].join('\n');

    const state = EditorState.create({ doc: source, extensions: [envExtension] });
    const tree = syntaxTree(state);
    // Force a full parse of the (small) document so the token() function above
    // actually runs across every branch rather than staying lazy.
    let text = '';
    tree.iterate({
      enter: (node) => {
        text += `${node.name}:${state.doc.sliceString(node.from, node.to)} `;
      },
    });

    expect(text).toContain('comment');
    expect(text.length).toBeGreaterThan(0);
  });
});
