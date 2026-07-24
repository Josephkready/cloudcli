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
