import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const codeMirrorSpy = vi.fn();

vi.mock('@uiw/react-codemirror', () => ({
  default: (props: Record<string, unknown>) => {
    codeMirrorSpy(props);
    return <div data-testid="codemirror-mock" />;
  },
}));

vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: 'one-dark-theme' }));

vi.mock('./markdown/MarkdownPreview', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown-preview">{content}</div>,
}));

const { default: CodeEditorSurface } = await import('./CodeEditorSurface');

describe('CodeEditorSurface', () => {
  it('renders CodeMirror with the given content, theme and basic-setup options', () => {
    render(
      <CodeEditorSurface
        content="const x = 1;"
        onChange={vi.fn()}
        markdownPreview={false}
        isMarkdownFile={false}
        isDarkMode
        fontSize={16}
        showLineNumbers
        extensions={[]}
      />,
    );

    expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument();
    expect(codeMirrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        value: 'const x = 1;',
        theme: 'one-dark-theme',
        basicSetup: expect.objectContaining({ lineNumbers: true }),
      }),
    );
  });

  it('uses no theme override in light mode', () => {
    render(
      <CodeEditorSurface
        content=""
        onChange={vi.fn()}
        markdownPreview={false}
        isMarkdownFile={false}
        isDarkMode={false}
        fontSize={12}
        showLineNumbers={false}
        extensions={[]}
      />,
    );

    expect(codeMirrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ theme: undefined, basicSetup: expect.objectContaining({ lineNumbers: false }) }),
    );
  });

  it('renders the markdown preview instead of CodeMirror for markdown files in preview mode', () => {
    render(
      <CodeEditorSurface
        content="# Title"
        onChange={vi.fn()}
        markdownPreview
        isMarkdownFile
        isDarkMode={false}
        fontSize={12}
        showLineNumbers
        extensions={[]}
      />,
    );

    expect(screen.getByTestId('markdown-preview')).toHaveTextContent('# Title');
    expect(screen.queryByTestId('codemirror-mock')).toBeNull();
  });

  it('stays on CodeMirror when preview is requested for a non-markdown file', () => {
    render(
      <CodeEditorSurface
        content="plain text"
        onChange={vi.fn()}
        markdownPreview
        isMarkdownFile={false}
        isDarkMode={false}
        fontSize={12}
        showLineNumbers
        extensions={[]}
      />,
    );

    expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument();
  });
});
