import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ThemeProvider } from '../../../../contexts/ThemeContext';
import { getLoadedMathRuntime, resetMathRuntimeForTests } from '../../../../shared/markdown/useMathPlugins';

import { MarkdownRenderer as Markdown } from './MarkdownRenderer';

// First test to render the chat Markdown chain in a real DOM. It is deliberately
// the harness's canary: `MarkdownRenderer` pulls in `react-syntax-highlighter`'s
// ESM build, which the bare `tsx --test` runner cannot load ("does not provide
// an export named 'oneDark'"). Vitest transforms through Vite, so a green run
// here proves the CJS/ESM interop wall that blocked component testing is gone.
//
// This exercises `MarkdownRenderer` directly rather than through the
// `Markdown.tsx` lazy wrapper (perf-audit package WP7): the wrapper adds a
// `React.lazy`/`Suspense` boundary that is covered by its own spec
// (`Markdown.spec.tsx`), and testing the renderer directly keeps these
// already-async (Prism/KaTeX) assertions from stacking another async hop.

function renderMarkdown(markdown: string) {
  return render(
    <ThemeProvider>
      <Markdown className="markdown-root">{markdown}</Markdown>
    </ThemeProvider>,
  );
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

  // Touch devices have no `:hover`, so a hover-only reveal (`opacity-0
  // group-hover:opacity-100`) left this button invisible yet still the
  // topmost, tappable element on iPad/phones — users could never see it, but
  // could still blind-tap it (vdebug invisible-hit-target check, ipad-pro-11).
  // `touch:opacity-100` is the repo's existing coarse/no-hover escape hatch
  // (see `.touch\:opacity-100` in src/index.css, already used by the sidebar
  // row actions) and must stay alongside the hover classes so desktop
  // hover-reveal is unchanged.
  it('keeps the copy button visible on touch/no-hover pointers, not just on hover', async () => {
    const { container } = renderMarkdown(FENCED_CODE);
    await waitForHighlighter(container);

    expect(screen.getByRole('button', { name: 'Copy code' })).toHaveClass(
      'touch:opacity-100',
      'opacity-0',
      'group-hover:opacity-100',
    );
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

// The in-app code editor was removed, so a link to a project file has nowhere to
// go: it renders as text (path on hover) instead of an anchor that would 404.
describe('MarkdownRenderer links', () => {
  it('renders a project file link as plain text with the path on hover', () => {
    const { container } = renderMarkdown('See [the loader](src/loader.ts:12) for details.');

    const text = screen.getByText('the loader');
    expect(text.tagName).toBe('SPAN');
    expect(text).toHaveAttribute('title', 'src/loader.ts:12');
    expect(container.querySelector('a')).toBeNull();
  });

  it('uses the link text when the href is empty, as models often emit', () => {
    renderMarkdown('Open [src/app.tsx]() next.');

    expect(screen.getByText('src/app.tsx')).toHaveAttribute('title', 'src/app.tsx');
  });

  it('keeps external links as new-tab anchors', () => {
    renderMarkdown('Docs: [Claude](https://docs.anthropic.com/en/docs).');

    const link = screen.getByRole('link', { name: 'Claude' });
    expect(link).toHaveAttribute('href', 'https://docs.anthropic.com/en/docs');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
