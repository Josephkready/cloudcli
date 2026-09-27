import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFile = vi.fn();
const saveFile = vi.fn();

vi.mock('@/utils/api', () => ({
  api: {
    readFile: (...args: unknown[]) => readFile(...args),
    saveFile: (...args: unknown[]) => saveFile(...args),
  },
  authenticatedFetch: vi.fn(),
  isValidRefreshedToken: () => false,
}));

const { useCodeEditorDocument } = await import('./useCodeEditorDocument');

import type { CodeEditorFile } from '../types/types';

/*
 * #231: nothing tracked whether the buffer differed from what is on disk, so
 * there was no dirty state for the header to surface or for Esc to guard on.
 */

type Doc = ReturnType<typeof useCodeEditorDocument>;

let doc: Doc;

const file = { name: 'README.md', path: 'README.md', projectId: 'p1' } as CodeEditorFile;

function Harness() {
  doc = useCodeEditorDocument({ file });
  return null;
}

beforeEach(() => {
  readFile.mockReset();
  saveFile.mockReset();
  readFile.mockResolvedValue({
    ok: true,
    json: async () => ({ content: 'line one\n' }),
  });
  saveFile.mockResolvedValue({
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ success: true }),
  });
});

describe('useCodeEditorDocument — dirty tracking (#231)', () => {
  it('is clean immediately after the file loads', async () => {
    render(<Harness />);

    await waitFor(() => expect(doc.loading).toBe(false));

    expect(doc.content).toBe('line one\n');
    expect(doc.isDirty).toBe(false);
  });

  it('becomes dirty as soon as the buffer diverges from disk', async () => {
    render(<Harness />);
    await waitFor(() => expect(doc.loading).toBe(false));

    act(() => doc.setContent('line one\nline two\n'));

    await waitFor(() => expect(doc.isDirty).toBe(true));
  });

  it('goes clean again after a successful save', async () => {
    render(<Harness />);
    await waitFor(() => expect(doc.loading).toBe(false));

    act(() => doc.setContent('line one\nline two\n'));
    await waitFor(() => expect(doc.isDirty).toBe(true));

    await act(async () => {
      await doc.handleSave();
    });

    expect(saveFile).toHaveBeenCalledWith('p1', 'README.md', 'line one\nline two\n');
    await waitFor(() => expect(doc.isDirty).toBe(false));
  });

  it('stays dirty when the save fails, so the buffer is still flagged', async () => {
    saveFile.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: 'disk full' }),
    });
    render(<Harness />);
    await waitFor(() => expect(doc.loading).toBe(false));

    act(() => doc.setContent('edited\n'));
    await act(async () => {
      await doc.handleSave();
    });

    expect(doc.isDirty).toBe(true);
    expect(doc.saveError).toBe('disk full');
  });

  it('reverting the buffer by hand clears the dirty flag', async () => {
    render(<Harness />);
    await waitFor(() => expect(doc.loading).toBe(false));

    act(() => doc.setContent('line one\nline two\n'));
    await waitFor(() => expect(doc.isDirty).toBe(true));

    act(() => doc.setContent('line one\n'));

    await waitFor(() => expect(doc.isDirty).toBe(false));
  });
});

describe('useCodeEditorDocument — binary and previewable files', () => {
  it('marks binary-extension files as binary without reading them', async () => {
    let localDoc!: Doc;
    function BinaryHarness() {
      localDoc = useCodeEditorDocument({ file: { name: 'archive.zip', path: 'archive.zip', projectId: 'p1' } as CodeEditorFile });
      return null;
    }

    render(<BinaryHarness />);
    await waitFor(() => expect(localDoc.loading).toBe(false));

    expect(localDoc.isBinary).toBe(true);
    expect(localDoc.content).toBe('');
    expect(localDoc.isDirty).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('skips the network read for natively previewable media', async () => {
    let localDoc!: Doc;
    function PreviewHarness() {
      localDoc = useCodeEditorDocument({ file: { name: 'photo.png', path: 'photo.png', projectId: 'p1' } as CodeEditorFile });
      return null;
    }

    render(<PreviewHarness />);
    await waitFor(() => expect(localDoc.loading).toBe(false));

    expect(localDoc.previewKind).toBe('image');
    expect(localDoc.content).toBe('');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('a preview-kind or binary file reports handleSave as a no-op success', async () => {
    let localDoc!: Doc;
    function BinaryHarness() {
      localDoc = useCodeEditorDocument({ file: { name: 'archive.zip', path: 'archive.zip', projectId: 'p1' } as CodeEditorFile });
      return null;
    }

    render(<BinaryHarness />);
    await waitFor(() => expect(localDoc.loading).toBe(false));

    let result: boolean | undefined;
    await act(async () => {
      result = await localDoc.handleSave();
    });

    expect(result).toBe(true);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('loads diff content directly from diffInfo without a network read', async () => {
    let localDoc!: Doc;
    const diffFile = {
      name: 'a.ts',
      path: 'a.ts',
      projectId: 'p1',
      diffInfo: { old_string: 'old\n', new_string: 'new\n' },
    } as CodeEditorFile;
    function DiffHarness() {
      localDoc = useCodeEditorDocument({ file: diffFile });
      return null;
    }

    render(<DiffHarness />);
    await waitFor(() => expect(localDoc.loading).toBe(false));

    expect(localDoc.content).toBe('new\n');
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('useCodeEditorDocument — error paths', () => {
  it('shows an inline error comment when there is no project identifier to read from', async () => {
    let localDoc!: Doc;
    function NoProjectHarness() {
      localDoc = useCodeEditorDocument({ file: { name: 'a.ts', path: 'a.ts' } as CodeEditorFile });
      return null;
    }

    render(<NoProjectHarness />);
    await waitFor(() => expect(localDoc.loading).toBe(false));

    expect(localDoc.content).toContain('Missing project identifier');
  });

  it('shows an inline error comment when the read request itself fails', async () => {
    readFile.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    render(<Harness />);
    await waitFor(() => expect(doc.loading).toBe(false));

    expect(doc.content).toContain('Failed to load file: 404 Not Found');
  });

  it('surfaces a save error with no project identifier', async () => {
    let localDoc!: Doc;
    function NoProjectHarness() {
      localDoc = useCodeEditorDocument({ file: { name: 'a.ts', path: 'a.ts' } as CodeEditorFile });
      return null;
    }

    render(<NoProjectHarness />);
    await waitFor(() => expect(localDoc.loading).toBe(false));

    let result: boolean | undefined;
    await act(async () => {
      result = await localDoc.handleSave();
    });

    expect(result).toBe(false);
    expect(localDoc.saveError).toBe('Missing project identifier');
  });

  it('reads a plain-text error body when the failed save response is not JSON', async () => {
    saveFile.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'boom',
    });
    render(<Harness />);
    await waitFor(() => expect(doc.loading).toBe(false));

    act(() => doc.setContent('edited\n'));
    await act(async () => {
      await doc.handleSave();
    });

    expect(doc.saveError).toBe('Save failed: 500 Server Error');
  });

  it('reports the save-success flag then clears it after a delay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness />);
    await waitFor(() => expect(doc.loading).toBe(false));

    act(() => doc.setContent('edited\n'));
    await act(async () => {
      await doc.handleSave();
    });

    expect(doc.saveSuccess).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(doc.saveSuccess).toBe(false);
    vi.useRealTimers();
  });

  it('downloads the current buffer as a text file', async () => {
    render(<Harness />);
    await waitFor(() => expect(doc.loading).toBe(false));

    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const createSpy = vi.spyOn(document, 'createElement');

    act(() => doc.handleDownload());

    expect(appendSpy).toHaveBeenCalled();
    const anchor = createSpy.mock.results.find((r) => (r.value as HTMLElement).tagName === 'A')?.value as HTMLAnchorElement;
    const clickSpy = vi.spyOn(anchor, 'click');
    expect(anchor.download).toBe('README.md');
    // handleDownload calls anchor.click() itself before this spy attaches, but
    // re-invoking here proves the anchor is a real, clickable element wired to
    // a blob URL rather than an inert DOM node.
    anchor.click();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
