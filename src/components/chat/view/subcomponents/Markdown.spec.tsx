import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PaletteOpsProvider, usePaletteOpsRegister } from '../../../../contexts/PaletteOpsContext';
import { ThemeProvider } from '../../../../contexts/ThemeContext';
import { getLoadedMathRuntime, resetMathRuntimeForTests } from '../../../../shared/markdown/useMathPlugins';

import { Markdown } from './Markdown';

// First test to render the chat Markdown chain in a real DOM. It is deliberately
// the harness's canary: `Markdown` pulls in `react-syntax-highlighter`'s ESM
// build, which the bare `tsx --test` runner cannot load ("does not provide an
// export named 'oneDark'"). Vitest transforms through Vite, so a green run here
// proves the CJS/ESM interop wall that blocked component testing is gone.

function RegisterPaletteOps({ openFileInEditor }: { openFileInEditor: (path: string) => void }) {
  usePaletteOpsRegister({ openFileInEditor });
  return null;
}

function renderMarkdown(markdown: string, openFileInEditor = vi.fn()) {
  const view = render(
    <ThemeProvider>
      <PaletteOpsProvider>
        <RegisterPaletteOps openFileInEditor={openFileInEditor} />
        <Markdown className="markdown-root">{markdown}</Markdown>
      </PaletteOpsProvider>
    </ThemeProvider>,
  );
  return { ...view, openFileInEditor };
}

const FENCED_CODE = ['```ts', 'const answer = 42;', 'const doubled = answer * 2;', '```'].join('\n');

/**
 * Waits for the demand-loaded Prism chunk to replace the fallback (#287).
 *
 * Keyed on the fallback DISAPPEARING rather than on tokens appearing, so it
 * also works for the unregistered-language case, where the real highlighter
 * legitimately produces no styled spans.
 */
async function waitForHighlighter(container: HTMLElement) {
  await waitFor(
    () => {
      expect(container.querySelector('[data-testid="plain-code-block"]')).toBeNull();
    },
    { timeout: 20_000 },
  );
}

describe('Markdown', () => {
  beforeEach(() => {
    resetMathRuntimeForTests();
  });

  it('renders a fenced block through react-syntax-highlighter', async () => {
    const { container } = renderMarkdown(FENCED_CODE);

    // #287: the highlighter is demand-loaded now, so tokenising is async.
    await waitForHighlighter(container);

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('const answer = 42;');
    // Prism tokenises the source into spans - proof the highlighter really ran
    // rather than the raw text falling through to a plain <pre>.
    expect(pre?.querySelectorAll('span').length).toBeGreaterThan(1);
    // The language badge and the copy affordance come from the CodeBlock wrapper.
    expect(screen.getByText('ts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
  });

  // Issue #268: the highlighter now registers an explicit language set instead
  // of shipping all ~290 Prism grammars, so the languages this UI actually emits
  // have to keep tokenising, and anything else has to fall back safely.
  it.each([
    ['python', 'def main():\n    return 42'],
    ['bash', 'echo hello\nls -la'],
    ['json', '{\n  "answer": 42\n}'],
    ['rust', 'fn main() {\n    println!("hi");\n}'],
  ])('highlights a %s fence', async (language, code) => {
    const { container } = renderMarkdown(['```' + language, code, '```'].join('\n'));

    await waitForHighlighter(container);

    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain(code.split('\n')[0]);
    expect(pre?.querySelectorAll('span[style]').length).toBeGreaterThan(0);
  });

  it('renders an unregistered language as plain text without throwing', async () => {
    const { container } = renderMarkdown(['```brainfuck', '+++[->+++<]', '', '```'].join('\n'));

    // Waiting for the highlighter matters here: the loading fallback also has
    // no styled spans, so asserting straight away would pass even if Prism
    // never loaded at all.
    await waitForHighlighter(container);

    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('+++[->+++<]');
    expect(pre?.querySelectorAll('span[style]').length).toBe(0);
  });

  // Issue #269: KaTeX is lazy. A math-free message must never load it; a message
  // with math must load it and end up with real KaTeX output.
  it('does not load the KaTeX runtime for a message without math', async () => {
    renderMarkdown('The plan costs $5 and the add-on costs $10.');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getLoadedMathRuntime()).toBeNull();
  });

  it('loads KaTeX on demand and renders display math', async () => {
    const { container } = renderMarkdown('The area is $$x^2$$ overall.');

    // Generous timeout: the KaTeX chunk may still be transforming cold here,
    // which can exceed RTL's 1s default on a loaded box.
    await waitFor(
      () => {
        expect(container.querySelector('.katex')).not.toBeNull();
      },
      { timeout: 20_000 },
    );
    expect(getLoadedMathRuntime()).not.toBeNull();
    // KaTeX emits a MathML annotation carrying the original TeX source.
    expect(container.querySelector('annotation')?.textContent).toBe('x^2');
  }, 30_000);
});
