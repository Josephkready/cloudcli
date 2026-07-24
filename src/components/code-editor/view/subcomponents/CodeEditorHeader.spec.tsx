import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CodeEditorFile } from '../../types/types';

import CodeEditorHeader from './CodeEditorHeader';

/*
 * #231: while dirty the header showed a plain filename — no dot, asterisk or
 * badge — and the save icon was not highlighted, so nothing in the UI told a
 * dirty buffer apart from a clean one.
 */

const file = { name: 'README.md', path: 'README.md' } as CodeEditorFile;

const labels = {
  showingChanges: 'Showing changes',
  editMarkdown: 'Edit markdown',
  previewMarkdown: 'Preview markdown',
  previewHtml: 'Preview HTML',
  settings: 'Editor Settings',
  download: 'Download file',
  save: 'Save',
  saving: 'Saving...',
  saved: 'Saved!',
  unsavedChanges: 'Unsaved changes',
  saveUnsaved: 'Save (unsaved changes)',
  fullscreen: 'Fullscreen',
  exitFullscreen: 'Exit fullscreen',
  close: 'Close',
};

function renderHeader(overrides: Record<string, unknown> = {}) {
  return render(
    <CodeEditorHeader
      file={file}
      isSidebar={false}
      isFullscreen={false}
      isMarkdownFile={false}
      isHtmlPreviewFile={false}
      markdownPreview={false}
      saving={false}
      saveSuccess={false}
      isDirty={false}
      onToggleMarkdownPreview={vi.fn()}
      onOpenHtmlPreview={vi.fn()}
      onOpenSettings={vi.fn()}
      onDownload={vi.fn()}
      onSave={vi.fn()}
      onToggleFullscreen={vi.fn()}
      onClose={vi.fn()}
      labels={labels}
      {...overrides}
    />,
  );
}

describe('CodeEditorHeader — unsaved-changes indicator (#231)', () => {
  it('shows no indicator for a clean buffer', () => {
    renderHeader();

    expect(screen.queryByLabelText('Unsaved changes')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('marks the filename and the save button while dirty', () => {
    renderHeader({ isDirty: true });

    expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save (unsaved changes)' })).toBeInTheDocument();
  });

  it('drops the indicator again once a save succeeds', () => {
    renderHeader({ isDirty: false, saveSuccess: true });

    expect(screen.queryByLabelText('Unsaved changes')).toBeNull();
    expect(screen.getByRole('button', { name: 'Saved!' })).toBeInTheDocument();
  });
});
