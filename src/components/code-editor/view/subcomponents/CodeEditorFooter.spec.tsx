import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import CodeEditorFooter from './CodeEditorFooter';

describe('CodeEditorFooter', () => {
  it('reports line and character counts derived from the content', () => {
    render(
      <CodeEditorFooter
        content={'line one\nline two\nline three'}
        linesLabel="Lines:"
        charactersLabel="Chars:"
        shortcutsLabel="Ctrl+S to save"
      />,
    );

    expect(screen.getByText('Lines: 3')).toBeInTheDocument();
    expect(screen.getByText(`Chars: ${'line one\nline two\nline three'.length}`)).toBeInTheDocument();
    expect(screen.getByText('Ctrl+S to save')).toBeInTheDocument();
  });

  it('counts a single empty line for empty content', () => {
    render(
      <CodeEditorFooter content="" linesLabel="Lines:" charactersLabel="Chars:" shortcutsLabel="" />,
    );
    expect(screen.getByText('Lines: 1')).toBeInTheDocument();
    expect(screen.getByText('Chars: 0')).toBeInTheDocument();
  });
});
