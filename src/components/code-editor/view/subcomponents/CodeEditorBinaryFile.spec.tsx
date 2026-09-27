import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CodeEditorFile } from '../../types/types';
import CodeEditorBinaryFile from './CodeEditorBinaryFile';

const file = { name: 'archive.zip', path: 'archive.zip' } as CodeEditorFile;

function renderBinary(overrides: Partial<React.ComponentProps<typeof CodeEditorBinaryFile>> = {}) {
  return render(
    <CodeEditorBinaryFile
      file={file}
      isSidebar={false}
      isFullscreen={false}
      onClose={vi.fn()}
      onToggleFullscreen={vi.fn()}
      title="Binary File"
      message="cannot be displayed"
      {...overrides}
    />,
  );
}

describe('CodeEditorBinaryFile', () => {
  it('shows the binary-file title and message', () => {
    renderBinary();
    expect(screen.getByText('Binary File')).toBeInTheDocument();
    expect(screen.getByText('cannot be displayed')).toBeInTheDocument();
  });

  it('closes via the in-body Close button', () => {
    const onClose = vi.fn();
    renderBinary({ onClose });
    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sidebar mode shows a compact header with its own close button and no fullscreen toggle', () => {
    const onClose = vi.fn();
    renderBinary({ isSidebar: true, onClose });

    expect(screen.getByText(file.name)).toBeInTheDocument();
    const closeButtons = screen.getAllByTitle('Close');
    expect(closeButtons).toHaveLength(1);
    fireEvent.click(closeButtons[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('modal mode toggles fullscreen and shows both title-bar icons', () => {
    const onToggleFullscreen = vi.fn();
    renderBinary({ isSidebar: false, isFullscreen: false, onToggleFullscreen });

    fireEvent.click(screen.getByTitle('Fullscreen'));
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it('shows "Exit fullscreen" title when already fullscreen', () => {
    renderBinary({ isSidebar: false, isFullscreen: true });
    expect(screen.getByTitle('Exit fullscreen')).toBeInTheDocument();
  });
});
