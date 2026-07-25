import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../../../../../contexts/ThemeContext';
import { getLoadedMathRuntime, resetMathRuntimeForTests } from '../../../../../shared/markdown/useMathPlugins';

import MarkdownPreview from './MarkdownPreview';

// The code-editor side of issues #268/#269. It shares `prismLanguages` and
// `useMathPlugins` with the chat renderer, and the whole point of that sharing
// is that the two cannot drift — which is only true if both are actually
// exercised. Vitest rather than `tsx --test` because this chain reaches
// `react-syntax-highlighter`'s ESM build (see CONTRIBUTING.md).

function renderPreview(content: string) {
  return render(
    <ThemeProvider>
      <MarkdownPreview content={content} />
    </ThemeProvider>,
  );
}

const fence = (language: string, code: string) => ['```' + language, code, '```'].join('\n');

describe('MarkdownPreview', () => {
  beforeEach(() => {
    resetMathRuntimeForTests();
  });

  it.each([
    ['typescript', 'const answer: number = 42;\nconst doubled = answer * 2;'],
    ['python', 'def main():\n    return 42'],
    ['yaml', 'key: value\nlist:\n  - one'],
  ])('highlights a %s fence', (language, code) => {
    const { container } = renderPreview(fence(language, code));

    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain(code.split('\n')[0]);
    expect(pre?.querySelectorAll('span[style]').length).toBeGreaterThan(0);
    expect(screen.getByText(language)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('renders an unregistered language as plain text without throwing', () => {
    const { container } = renderPreview(fence('brainfuck', '+++[->+++<]\n>.'));

    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('+++[->+++<]');
    expect(pre?.querySelectorAll('span[style]').length).toBe(0);
  });

  it('renders a single-line span inline rather than as a highlighted block', () => {
    const { container } = renderPreview('Call `normalizeInlineCodeFences` first.');

    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('normalizeInlineCodeFences');
  });

  it('still renders GFM tables', () => {
    const { container } = renderPreview(['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'));

    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  it('does not load the KaTeX runtime for a file without math', async () => {
    renderPreview('Pricing: the starter plan costs $5 and the pro plan costs $10.');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getLoadedMathRuntime()).toBeNull();
  });

  it('loads KaTeX on demand for a file with math', async () => {
    const { container } = renderPreview('Pythagoras: $$a^2 + b^2 = c^2$$');

    // Generous timeout: this may pay for the cold transform of the KaTeX chunk.
    await waitFor(
      () => {
        expect(container.querySelector('.katex')).not.toBeNull();
      },
      { timeout: 20_000 },
    );
    expect(container.querySelector('annotation')?.textContent).toBe('a^2 + b^2 = c^2');
  }, 30_000);

  it('copies a code block to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);

    renderPreview(fence('json', '{\n  "answer": 42\n}'));
    screen.getByRole('button', { name: 'Copy' }).click();

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"answer": 42'));
    });
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });
});
