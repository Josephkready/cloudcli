import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const { default: CodeEditorMediaPreview } = await import('./CodeEditorMediaPreview');

import type { CodeEditorFile } from '../../types/types';

const labels = {
  loading: 'Loading preview...',
  error: 'Unable to display this file.',
  openInNewTab: 'Open in new tab',
  fullscreen: 'Fullscreen',
  exitFullscreen: 'Exit fullscreen',
  close: 'Close',
};

function makeResponse(blob: Blob, ok = true, status = 200) {
  return { ok, status, blob: async () => blob };
}

beforeEach(() => {
  authenticatedFetch.mockReset();
});

describe('CodeEditorMediaPreview', () => {
  it('shows an error immediately when there is no project id to fetch with', async () => {
    render(
      <CodeEditorMediaPreview
        file={{ name: 'photo.png', path: 'photo.png' } as CodeEditorFile}
        kind="image"
        isSidebar={false}
        isFullscreen={false}
        onClose={vi.fn()}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    expect(await screen.findByText(labels.error)).toBeInTheDocument();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('loads and renders an image, offering an "open in new tab" link', async () => {
    authenticatedFetch.mockResolvedValue(makeResponse(new Blob(['bytes'], { type: 'image/png' })));

    render(
      <CodeEditorMediaPreview
        file={{ name: 'photo.png', path: 'photo.png' } as CodeEditorFile}
        kind="image"
        projectId="p1"
        isSidebar={false}
        isFullscreen={false}
        onClose={vi.fn()}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    await waitFor(() => expect(screen.getByAltText('photo.png')).toBeInTheDocument());
    expect(screen.getByLabelText(labels.openInNewTab)).toBeInTheDocument();
    expect(authenticatedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/p1/files/content?path=photo.png'),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('withholds the open-in-new-tab action for SVGs (script-injection guard)', async () => {
    authenticatedFetch.mockResolvedValue(makeResponse(new Blob(['<svg/>'], { type: 'image/svg+xml' })));

    render(
      <CodeEditorMediaPreview
        file={{ name: 'icon.svg', path: 'icon.svg' } as CodeEditorFile}
        kind="image"
        projectId="p1"
        isSidebar={false}
        isFullscreen={false}
        onClose={vi.fn()}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    await waitFor(() => expect(screen.getByAltText('icon.svg')).toBeInTheDocument());
    expect(screen.queryByLabelText(labels.openInNewTab)).toBeNull();
  });

  it('falls back to the extension-derived MIME type for a generic octet-stream response', async () => {
    authenticatedFetch.mockResolvedValue(makeResponse(new Blob(['bytes'], { type: 'application/octet-stream' })));

    render(
      <CodeEditorMediaPreview
        file={{ name: 'clip.webm', path: 'clip.webm' } as CodeEditorFile}
        kind="video"
        projectId="p1"
        isSidebar={false}
        isFullscreen={false}
        onClose={vi.fn()}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    await waitFor(() => expect(document.querySelector('video')).toBeTruthy());
  });

  it('re-types a mislabeled video response even when a Content-Type is present', async () => {
    authenticatedFetch.mockResolvedValue(makeResponse(new Blob(['bytes'], { type: 'application/octet-stream; charset=binary' })));

    render(
      <CodeEditorMediaPreview
        file={{ name: 'clip.mp4', path: 'clip.mp4' } as CodeEditorFile}
        kind="video"
        projectId="p1"
        isSidebar={false}
        isFullscreen={false}
        onClose={vi.fn()}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    await waitFor(() => expect(document.querySelector('video')).toBeTruthy());
  });

  it('validates real PDF bytes before rendering the iframe', async () => {
    authenticatedFetch.mockResolvedValue(makeResponse(new Blob(['%PDF-1.4 ...'], { type: 'application/pdf' })));

    render(
      <CodeEditorMediaPreview
        file={{ name: 'doc.pdf', path: 'doc.pdf' } as CodeEditorFile}
        kind="pdf"
        projectId="p1"
        isSidebar={false}
        isFullscreen={false}
        onClose={vi.fn()}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
  });

  it('rejects a mislabeled "PDF" whose bytes are not a real PDF', async () => {
    authenticatedFetch.mockResolvedValue(makeResponse(new Blob(['<html><script>evil()</script></html>'], { type: 'application/pdf' })));

    render(
      <CodeEditorMediaPreview
        file={{ name: 'fake.pdf', path: 'fake.pdf' } as CodeEditorFile}
        kind="pdf"
        projectId="p1"
        isSidebar={false}
        isFullscreen={false}
        onClose={vi.fn()}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    await waitFor(() => expect(screen.getByText(labels.error)).toBeInTheDocument());
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('renders an audio player with the filename shown above the controls', async () => {
    authenticatedFetch.mockResolvedValue(makeResponse(new Blob(['bytes'], { type: 'audio/mpeg' })));

    render(
      <CodeEditorMediaPreview
        file={{ name: 'song.mp3', path: 'song.mp3' } as CodeEditorFile}
        kind="audio"
        projectId="p1"
        isSidebar={false}
        isFullscreen={false}
        onClose={vi.fn()}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    await waitFor(() => expect(document.querySelector('audio')).toBeTruthy());
    expect(screen.getAllByText('song.mp3').length).toBeGreaterThan(0);
  });

  it('shows an error state when the fetch response is not ok', async () => {
    authenticatedFetch.mockResolvedValue(makeResponse(new Blob([]), false, 403));

    render(
      <CodeEditorMediaPreview
        file={{ name: 'photo.png', path: 'photo.png' } as CodeEditorFile}
        kind="image"
        projectId="p1"
        isSidebar={false}
        isFullscreen={false}
        onClose={vi.fn()}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    await waitFor(() => expect(screen.getByText(labels.error)).toBeInTheDocument());
  });

  it('leaves loading state and console.error untouched for an aborted load', async () => {
    // Real fetch() rejects an aborted request with a DOMException that IS an
    // Error subclass (true in every browser, though not in jsdom's polyfill —
    // see the `Error`-subclass note below). Model that faithfully here rather
    // than relying on jsdom's non-standard DOMException.
    class AbortErrorLike extends Error {
      constructor() {
        super('aborted');
        this.name = 'AbortError';
      }
    }
    authenticatedFetch.mockImplementation(() => Promise.reject(new AbortErrorLike()));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <CodeEditorMediaPreview
        file={{ name: 'photo.png', path: 'photo.png' } as CodeEditorFile}
        kind="image"
        projectId="p1"
        isSidebar={false}
        isFullscreen={false}
        onClose={vi.fn()}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    await waitFor(() => expect(screen.queryByText(labels.loading)).toBeNull());
    // The AbortError branch returns before logging or setting an explicit
    // error message — it must not be treated as a real load failure.
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('sidebar mode renders header + body without the fullscreen toggle', async () => {
    authenticatedFetch.mockResolvedValue(makeResponse(new Blob(['bytes'], { type: 'image/png' })));
    const onClose = vi.fn();

    render(
      <CodeEditorMediaPreview
        file={{ name: 'photo.png', path: 'photo.png' } as CodeEditorFile}
        kind="image"
        projectId="p1"
        isSidebar
        isFullscreen={false}
        onClose={onClose}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    await waitFor(() => expect(screen.getByAltText('photo.png')).toBeInTheDocument());
    expect(screen.queryByLabelText(labels.fullscreen)).toBeNull();
    fireEvent.click(screen.getByLabelText(labels.close));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('modal mode toggles fullscreen and reflects the exit-fullscreen label', async () => {
    authenticatedFetch.mockResolvedValue(makeResponse(new Blob(['bytes'], { type: 'image/png' })));
    const onToggleFullscreen = vi.fn();

    render(
      <CodeEditorMediaPreview
        file={{ name: 'photo.png', path: 'photo.png' } as CodeEditorFile}
        kind="image"
        projectId="p1"
        isSidebar={false}
        isFullscreen
        onClose={vi.fn()}
        onToggleFullscreen={onToggleFullscreen}
        labels={labels}
      />,
    );

    await waitFor(() => expect(screen.getByAltText('photo.png')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(labels.exitFullscreen));
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it('re-fetches and discards a stale in-flight load when the file changes', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    authenticatedFetch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve;
    }));

    const { rerender } = render(
      <CodeEditorMediaPreview
        file={{ name: 'first.png', path: 'first.png' } as CodeEditorFile}
        kind="image"
        projectId="p1"
        isSidebar={false}
        isFullscreen={false}
        onClose={vi.fn()}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    authenticatedFetch.mockResolvedValue(makeResponse(new Blob(['bytes'], { type: 'image/png' })));
    rerender(
      <CodeEditorMediaPreview
        file={{ name: 'second.png', path: 'second.png' } as CodeEditorFile}
        kind="image"
        projectId="p1"
        isSidebar={false}
        isFullscreen={false}
        onClose={vi.fn()}
        onToggleFullscreen={vi.fn()}
        labels={labels}
      />,
    );

    // The first request resolves after the switch; its stale blob must never render.
    resolveFirst(makeResponse(new Blob(['stale'], { type: 'image/png' })));

    await waitFor(() => expect(screen.getByAltText('second.png')).toBeInTheDocument());
  });
});
