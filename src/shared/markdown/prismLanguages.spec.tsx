import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SyntaxHighlighter, {
  PRISM_LANGUAGE_ALIASES,
  REGISTERED_PRISM_LANGUAGES,
  getPrismTheme,
} from './prismLanguages';

// Lives in the vitest tier, not `tsx --test`: this module imports
// `react-syntax-highlighter/dist/esm/...`, whose CJS/ESM interop only Vite's
// transform resolves (see CONTRIBUTING.md).

function highlight(language: string, code: string) {
  const { container } = render(
    <SyntaxHighlighter language={language} style={getPrismTheme(true)}>
      {code}
    </SyntaxHighlighter>,
  );
  const pre = container.querySelector('pre');
  return {
    text: pre?.textContent ?? '',
    tokenCount: pre?.querySelectorAll('span[style]').length ?? 0,
  };
}

// One representative snippet per registered grammar. Registration is what the
// `prism-light` build (issue #268) makes the caller's job, so a grammar that
// silently stops being registered has to fail a test rather than quietly
// degrade to grey text in the UI.
const SNIPPETS: Array<[string, string]> = [
  ['bash', 'echo "hello" | grep -o hello'],
  ['css', '.a { color: red; }'],
  ['diff', '- removed\n+ added'],
  ['go', 'func main() { println("hi") }'],
  ['javascript', 'const answer = 42;'],
  ['json', '{ "answer": 42 }'],
  ['jsx', 'const A = () => <div className="x" />;'],
  ['markdown', '# Title\n\nSome **bold** text.'],
  ['markup', '<div class="x">hi</div>'],
  ['python', 'def main():\n    return 42'],
  ['rust', 'fn main() { println!("hi"); }'],
  ['sql', 'SELECT id FROM users WHERE id = 1;'],
  ['tsx', 'const A = (): JSX.Element => <div />;'],
  ['typescript', 'const answer: number = 42;'],
  ['yaml', 'key: value\nlist:\n  - one'],
];

describe('prismLanguages', () => {
  it('registers exactly the documented grammar set', () => {
    expect([...REGISTERED_PRISM_LANGUAGES].sort()).toEqual(SNIPPETS.map(([name]) => name).sort());
  });

  for (const [language, code] of SNIPPETS) {
    it(`tokenises ${language}`, () => {
      const { text, tokenCount } = highlight(language, code);
      expect(text).toContain(code.split('\n')[0]);
      // Styled spans are only produced when a grammar actually matched.
      expect(tokenCount).toBeGreaterThan(0);
    });
  }

  // Grammar-supplied aliases (`ts`, `py`, `yml`, `md`, `js`, `html`, `shell`)
  // plus the extra spellings prismLanguages registers by hand.
  const ALIAS_SNIPPETS: Array<[string, string]> = [
    ['ts', 'const answer: number = 42;'],
    ['js', 'const answer = 42;'],
    ['py', 'def main():\n    return 42'],
    ['yml', 'key: value'],
    ['md', '# Title'],
    ['html', '<div class="x">hi</div>'],
    ['shell', 'echo hello'],
    ['sh', 'echo hello'],
    ['zsh', 'echo hello'],
    ['shell-session', 'echo hello'],
    ['console', 'echo hello'],
    ['golang', 'func main() { println("hi") }'],
    ['rs', 'fn main() { println!("hi"); }'],
  ];

  it('covers every hand-registered alias', () => {
    const covered = new Set(ALIAS_SNIPPETS.map(([alias]) => alias));
    for (const alias of Object.values(PRISM_LANGUAGE_ALIASES).flat()) {
      expect(covered.has(alias), `alias "${alias}" has no snippet in this spec`).toBe(true);
    }
  });

  it.each(ALIAS_SNIPPETS)('resolves the "%s" alias', (alias, code) => {
    const { tokenCount } = highlight(alias, code);
    expect(tokenCount, `alias "${alias}" highlighted nothing`).toBeGreaterThan(0);
  });

  it('degrades an unregistered language to plain text instead of throwing', () => {
    for (const language of ['brainfuck', 'abap', 'cobol', 'not-a-language']) {
      const { text, tokenCount } = highlight(language, '+++[->+++<]');
      expect(text).toContain('+++[->+++<]');
      expect(tokenCount).toBe(0);
    }
  });

  it('renders `text` fences as plain text', () => {
    const { text, tokenCount } = highlight('text', 'just words\nacross lines');
    expect(text).toContain('just words');
    expect(tokenCount).toBe(0);
  });

  it('serves a different theme per colour mode', () => {
    const dark = getPrismTheme(true);
    const light = getPrismTheme(false);
    expect(dark).not.toBe(light);
    expect(dark['pre[class*="language-"]']?.background).not.toEqual(light['pre[class*="language-"]']?.background);
  });
});
