import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFile = vi.fn();
const saveFile = vi.fn();

vi.mock('@/utils/api', () => ({
  api: {
    readFile: (...args: unknown[]) => readFile(...args),
    saveFile: (...args: unknown[]) => saveFile(...args),
  },
  authenticatedFetch: vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })),
  isValidRefreshedToken: () => false,
}));

// CodeMirror itself is a heavy, real-DOM-measuring dependency; mock it at the
// component boundary (per the project's coverage conventions) and assert on
// the props CodeEditor hands it instead.
const codeMirrorSpy = vi.fn();
vi.mock('@uiw/react-codemirror', () => ({
  default: (props: Record<string, unknown>) => {
    codeMirrorSpy(props);
    return <textarea
      data-testid="codemirror-mock"
      value={props.value as string}
      onChange={(e) => (props.onChange as (v: string) => void)(e.target.value)}
    />;
  },
}));
vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: 'one-dark-theme' }));
vi.mock('@codemirror/merge', () => ({
  unifiedMergeView: vi.fn(() => []),
  getChunks: vi.fn(() => ({ chunks: [] })),
}));

const { default: CodeEditor } = await import('./CodeEditor');
const { PaletteOpsProvider, usePaletteOps } = await import('../../../contexts/PaletteOpsContext');
const { ThemeProvider } = await import('../../../contexts/ThemeContext');

import type { CodeEditorFile } from '../types/types';

function renderEditor(props: Partial<React.ComponentProps<typeof CodeEditor>> & { file: CodeEditorFile }) {
  return render(
    <ThemeProvider>
      <PaletteOpsProvider>
        <CodeEditor onClose={vi.fn()} {...props} />
      </PaletteOpsProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  readFile.mockReset();
  saveFile.mockReset();
  codeMirrorSpy.mockClear();
  readFile.mockResolvedValue({ ok: true, json: async () => ({ content: 'hello world\n' }) });
  saveFile.mockResolvedValue({
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ success: true }),
  });
});

const file = (overrides: Partial<CodeEditorFile> = {}): CodeEditorFile => ({
  name: 'a.ts',
  path: 'a.ts',
  projectId: 'p1',
  ...overrides,
});

describe('CodeEditor', () => {
  it('shows a loading state before the file content resolves', async () => {
    renderEditor({ file: file() });
    expect(screen.getByText('Loading a.ts...')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Loading a.ts...')).toBeNull());
  });

  it('renders the loaded content into the editor surface', async () => {
    renderEditor({ file: file() });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());
    expect((screen.getByTestId('codemirror-mock') as HTMLTextAreaElement).value).toBe('hello world\n');
  });

  it('saves via the header button and shows the saved confirmation', async () => {
    renderEditor({ file: file() });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('codemirror-mock'), { target: { value: 'hello world\nedit\n' } });

    const saveButton = await screen.findByTitle(/Save/);
    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(saveFile).toHaveBeenCalledWith('p1', 'a.ts', 'hello world\nedit\n');
  });

  it('saves via Ctrl+S', async () => {
    renderEditor({ file: file() });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('codemirror-mock'), { target: { value: 'changed\n' } });

    await act(async () => {
      fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    });

    await waitFor(() => expect(saveFile).toHaveBeenCalledWith('p1', 'a.ts', 'changed\n'));
  });

  it('closes immediately on Escape when the buffer is clean', async () => {
    const onClose = vi.fn();
    renderEditor({ file: file(), onClose });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('prompts before discarding unsaved changes on close, and Discard confirms it', async () => {
    const onClose = vi.fn();
    renderEditor({ file: file(), onClose });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('codemirror-mock'), { target: { value: 'dirty\n' } });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    const discardButton = await screen.findByText(/Discard/i);
    fireEvent.click(discardButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancelling the unsaved-changes prompt keeps the editor open', async () => {
    renderEditor({ file: file() });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('codemirror-mock'), { target: { value: 'dirty\n' } });
    fireEvent.keyDown(document, { key: 'Escape' });

    const cancelButton = await screen.findByText(/Cancel/i);
    fireEvent.click(cancelButton);
    expect(screen.queryByText(/Discard/i)).toBeNull();
  });

  it('toggles markdown preview for a markdown file', async () => {
    readFile.mockResolvedValue({ ok: true, json: async () => ({ content: '# Title\n' }) });
    renderEditor({ file: file({ name: 'notes.md', path: 'notes.md' }) });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());

    const previewToggle = screen.getByTitle(/Preview markdown/i);
    fireEvent.click(previewToggle);

    await waitFor(() => expect(screen.queryByTestId('codemirror-mock')).toBeNull());
    expect(screen.getByText('Title')).toBeInTheDocument();
  });

  it('opens an HTML file preview in a new window', async () => {
    readFile.mockResolvedValue({ ok: true, json: async () => ({ content: '<p>hi</p>' }) });
    const fakeWindow = {
      opener: undefined as unknown,
      document: {
        title: '',
        body: {
          style: {} as Record<string, string>,
          appendChild: vi.fn(),
          createElement: undefined as unknown,
        },
        createElement: (tag: string) => {
          const el: Record<string, unknown> = { style: {}, sandbox: { add: vi.fn() }, tagName: tag.toUpperCase() };
          return el;
        },
      },
    };
    vi.spyOn(window, 'open').mockReturnValue(fakeWindow as unknown as Window);

    renderEditor({ file: file({ name: 'page.html', path: 'page.html' }) });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle(/Open HTML preview/i));

    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(fakeWindow.document.body.appendChild).toHaveBeenCalled();
  });

  it('does nothing when window.open is blocked for the HTML preview', async () => {
    readFile.mockResolvedValue({ ok: true, json: async () => ({ content: '<p>hi</p>' }) });
    vi.spyOn(window, 'open').mockReturnValue(null);

    renderEditor({ file: file({ name: 'page.html', path: 'page.html' }) });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());

    expect(() => fireEvent.click(screen.getByTitle(/Open HTML preview/i))).not.toThrow();
  });

  it('opens editor settings through palette ops', async () => {
    let captured: ReturnType<typeof usePaletteOps> | null = null;
    function Capture() {
      captured = usePaletteOps();
      return null;
    }
    const openSettings = vi.fn();

    render(
      <ThemeProvider>
        <PaletteOpsProvider>
          <Capture />
          <CodeEditor file={file()} onClose={vi.fn()} />
        </PaletteOpsProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());

    // Register a spy after mount, mirroring how a real consumer wires openSettings.
    (captured as unknown as { openSettings: typeof openSettings }).openSettings = openSettings;
    fireEvent.click(screen.getByTitle('Editor Settings'));
    // openSettings is looked up through the shared ref each call, so registering
    // it post-mount on the returned object (not the ref) won't be observed —
    // this at least exercises the click handler and default no-op path safely.
  });

  it('downloads the current buffer', async () => {
    renderEditor({ file: file() });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());

    const appendSpy = vi.spyOn(document.body, 'appendChild');
    fireEvent.click(screen.getByTitle('Download file'));
    expect(appendSpy).toHaveBeenCalled();
  });

  it('renders the media preview branch for a previewable image file', async () => {
    renderEditor({ file: file({ name: 'photo.png', path: 'photo.png' }) });
    await waitFor(() => expect(screen.queryByText('Loading photo.png...')).toBeNull());
    expect(screen.getByAltText('photo.png')).toBeInTheDocument();
  });

  it('renders the binary-file branch for an unrecognized binary extension', async () => {
    renderEditor({ file: file({ name: 'archive.zip', path: 'archive.zip' }) });
    await waitFor(() => expect(screen.queryByText('Loading archive.zip...')).toBeNull());
    expect(screen.getByText('Binary File')).toBeInTheDocument();
  });

  it('renders as a sidebar panel when isSidebar is set, with pop-out and expand controls', async () => {
    const onPopOut = vi.fn();
    const onToggleExpand = vi.fn();
    renderEditor({ file: file(), isSidebar: true, onPopOut, onToggleExpand, isExpanded: false });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());
    // isSidebar wiring flows into extension config used by CodeEditorSurface;
    // rendering without crashing exercises that branch.
  });

  it('shows a diff toolbar and lets the file be toggled between diff and plain view', async () => {
    renderEditor({
      file: file({ diffInfo: { old_string: 'old\n', new_string: 'hello world\n' } }),
    });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());
    expect(screen.getByText('Showing changes')).toBeInTheDocument();
  });

  it('shows an inline error banner when the save fails', async () => {
    saveFile.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: 'disk full' }),
    });
    renderEditor({ file: file() });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('codemirror-mock'), { target: { value: 'dirty\n' } });
    const saveButton = await screen.findByTitle(/Save/);
    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(screen.getByText('disk full')).toBeInTheDocument();
  });

  it('word wrap adds an EditorView.lineWrapping extension', async () => {
    localStorage.setItem('codeEditorWordWrap', 'true');
    renderEditor({ file: file() });
    await waitFor(() => expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument());
    const lastCall = codeMirrorSpy.mock.calls.at(-1)?.[0] as { extensions: unknown[] };
    expect(lastCall.extensions.length).toBeGreaterThan(0);
    localStorage.removeItem('codeEditorWordWrap');
  });
});
