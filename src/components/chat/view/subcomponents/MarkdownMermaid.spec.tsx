import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PaletteOpsProvider } from '../../../../contexts/PaletteOpsContext';
import { ThemeProvider } from '../../../../contexts/ThemeContext';
import { resetMermaidRuntimeForTests } from '../../../../shared/markdown/mermaidRuntimeLoader';

import { Markdown } from './Markdown';

/*
 * Mermaid rendering as the chat pipeline actually wires it: a whole message in,
 * a diagram (or a code block) out.
 *
 * `Markdown.spec.tsx` owns the general markdown behaviour; this file is separate
 * because it needs the mermaid runtime mocked for the whole module, and because
 * the questions it asks are all about which fences do and do not become
 * diagrams. The runtime itself is stubbed for the same reason as in
 * `MermaidDiagram.spec.tsx`: jsdom cannot measure text, so real mermaid fails
 * for a reason no browser ever hits. `e2e/mermaid.spec.ts` renders a real one.
 */
const { renderMermaid } = vi.hoisted(() => ({ renderMermaid: vi.fn() }));
vi.mock('../../../../shared/markdown/mermaidRuntime', () => ({ renderMermaid }));

const SVG = '<svg data-diagram="yes"><g><text>A</text></g></svg>';

function renderMarkdown(markdown: string) {
  return render(
    <ThemeProvider>
      <PaletteOpsProvider>
        <Markdown className="markdown-root">{markdown}</Markdown>
      </PaletteOpsProvider>
    </ThemeProvider>,
  );
}

const fence = (language: string, body: string) => ['```' + language, body, '```'].join('\n');

describe('Markdown — mermaid fences', () => {
  beforeEach(() => {
    resetMermaidRuntimeForTests();
    renderMermaid.mockReset();
    renderMermaid.mockResolvedValue(SVG);
  });

  it('renders a closed ```mermaid fence as a diagram', async () => {
    const { container } = renderMarkdown(
      ['Here is the flow:', fence('mermaid', 'graph TD\n  A --> B'), 'Done.'].join('\n\n'),
    );

    await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument());
    expect(container.querySelector('svg[data-diagram="yes"]')).not.toBeNull();
    expect(renderMermaid).toHaveBeenCalledTimes(1);
    expect(renderMermaid.mock.calls[0][0].code).toBe('graph TD\n  A --> B');

    // The prose around the diagram is untouched.
    expect(screen.getByText('Here is the flow:')).toBeInTheDocument();
    expect(screen.getByText('Done.')).toBeInTheDocument();
  });

  it('renders the source instead when the diagram will not parse', async () => {
    // The message must survive: no throw, no blank bubble, and every other part
    // of the transcript still on screen.
    renderMermaid.mockResolvedValue(null);

    const { container } = renderMarkdown(
      ['Broken one:', fence('mermaid', 'graph TD\n  A -->|'), 'Text after the diagram.'].join('\n\n'),
    );

    await waitFor(() => expect(renderMermaid).toHaveBeenCalled());
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull();
    expect(container.textContent).toContain('graph TD');
    expect(screen.getByText('Broken one:')).toBeInTheDocument();
    expect(screen.getByText('Text after the diagram.')).toBeInTheDocument();
  });

  it('does not touch mermaid for a fence that is still streaming', async () => {
    // Mid-stream the closing fence has not arrived, so the source is a prefix of
    // the diagram. Parsing it would either fail or draw the wrong picture, and
    // either way the reader would watch it flicker on every token.
    const streaming = ['Let me draw that:', '```mermaid', 'graph TD', '  A --> B'].join('\n');

    const { container } = renderMarkdown(streaming);

    await waitFor(() => expect(container.textContent).toContain('graph TD'));
    expect(renderMermaid).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull();
  });

  it('renders the diagram once the closing fence arrives', async () => {
    const streaming = ['```mermaid', 'graph TD', '  A --> B'].join('\n');
    const { container, rerender } = render(
      <ThemeProvider>
        <PaletteOpsProvider>
          <Markdown>{streaming}</Markdown>
        </PaletteOpsProvider>
      </ThemeProvider>,
    );
    // Settle the effects first — asserting synchronously would pass even with
    // the streaming gate removed, because the runtime call is a microtask away.
    await waitFor(() => expect(container.textContent).toContain('graph TD'));
    expect(renderMermaid).not.toHaveBeenCalled();

    rerender(
      <ThemeProvider>
        <PaletteOpsProvider>
          <Markdown>{`${streaming}\n\`\`\``}</Markdown>
        </PaletteOpsProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument());
  });

  it.each([
    ['ts', 'const answer = 42;'],
    ['python', 'def main():\n    return 42'],
    ['', 'plain fenced text\nsecond line'],
  ])('leaves a ```%s fence completely alone', async (language, body) => {
    const { container } = renderMarkdown(fence(language, body));

    await waitFor(() => expect(container.textContent).toContain(body.split('\n')[0]));
    expect(renderMermaid).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull();
  });

  it.each(['mermaidjs', 'mermaid-something'])(
    'does not treat a ```%s fence as mermaid',
    async (language) => {
      // `Markdown.tsx` reads its language badge with `/language-(\w+)/`, which
      // stops at the hyphen and reports `mermaid` for `mermaid-something`. The
      // mermaid decision reads the class list instead, which is why this passes.
      const { container } = renderMarkdown(fence(language, 'graph TD\n  A --> B'));

      await waitFor(() => expect(container.textContent).toContain('graph TD'));
      expect(renderMermaid).not.toHaveBeenCalled();
      expect(screen.queryByTestId('mermaid-diagram')).toBeNull();
    },
  );

  it('renders a one-line mermaid fence as a diagram, not as inline code', async () => {
    // Single-line fenced content normally falls through to the inline `<code>`
    // branch; a diagram is a block whatever its length.
    renderMarkdown(fence('mermaid', 'graph LR; A-->B'));

    await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument());
  });

  it('renders several diagrams in one message', async () => {
    renderMarkdown(
      [fence('mermaid', 'graph TD\n  A --> B'), 'and', fence('mermaid', 'graph LR\n  C --> D')].join('\n\n'),
    );

    await waitFor(() => expect(screen.getAllByTestId('mermaid-diagram')).toHaveLength(2));
    expect(renderMermaid.mock.calls.map((call) => call[0].code)).toEqual([
      'graph TD\n  A --> B',
      'graph LR\n  C --> D',
    ]);
  });

  it('renders the finished diagram while a later one is still streaming', async () => {
    const markdown = [
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      'and the next one:',
      '```mermaid',
      'graph LR',
    ].join('\n');

    renderMarkdown(markdown);

    await waitFor(() => expect(screen.getAllByTestId('mermaid-diagram')).toHaveLength(1));
    expect(renderMermaid).toHaveBeenCalledTimes(1);
    expect(renderMermaid.mock.calls[0][0].code).toBe('graph TD\n  A --> B');
  });
});
