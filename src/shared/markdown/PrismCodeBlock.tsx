/**
 * The highlighted `<pre>` for a fenced code block, isolated so it can be
 * demand-loaded (#287).
 *
 * WHY THIS MODULE EXISTS
 *   `prismLanguages` is ~100 KB of the entry chunk — the highlighter plus the
 *   registered grammars. It was reachable from `Markdown.tsx`, which renders
 *   every assistant message, so it loaded on boot even for a session with no
 *   code in it. Pulling it behind a `lazy()` boundary needs the import to sit in
 *   a module of its own, so this component is the only thing on the far side of
 *   that boundary and `Markdown.tsx` holds no Prism types.
 *
 * NOTHING HERE MAY BE IMPORTED BY THE FALLBACK. `PlainCodeBlock` renders while
 * this module is still downloading; if it imports from this file it drags Prism
 * back into the entry chunk. Shared metrics live in `codeBlockStyle.ts` for
 * exactly that reason — `entryStaticImports.test.ts` fails if the edge returns.
 */
import {
  CODE_BLOCK_FONT_FAMILY,
  CODE_BLOCK_FONT_SIZE,
  CODE_BLOCK_RADIUS,
  codeBlockPadding,
} from './codeBlockStyle';
import SyntaxHighlighter, { getPrismTheme } from './prismLanguages';

export type PrismCodeBlockProps = {
  code: string;
  language: string;
  isDarkMode: boolean;
};

export default function PrismCodeBlock({ code, language, isDarkMode }: PrismCodeBlockProps) {
  return (
    <SyntaxHighlighter
      language={language}
      style={getPrismTheme(isDarkMode)}
      customStyle={{
        margin: 0,
        borderRadius: CODE_BLOCK_RADIUS,
        fontSize: CODE_BLOCK_FONT_SIZE,
        padding: codeBlockPadding(language),
        // ChatGPT-style soft grey block in light mode; keep oneDark's own bg in dark.
        ...(isDarkMode ? {} : { background: 'hsl(var(--muted))' }),
      }}
      codeTagProps={{
        style: {
          fontFamily: CODE_BLOCK_FONT_FAMILY,
          ...(isDarkMode ? {} : { background: 'transparent' }),
        },
      }}
    >
      {code}
    </SyntaxHighlighter>
  );
}
