/**
 * Unhighlighted stand-in shown while the Prism bundle loads (#287).
 *
 * The point is that swapping this for the real highlighter changes COLOUR and
 * nothing else, so the first assistant message does not reflow underneath the
 * reader. It shares its metrics with `PrismCodeBlock` through
 * `codeBlockStyle.ts`; if those drift apart the block visibly jumps as the
 * highlighter arrives.
 *
 * It must NOT import from `PrismCodeBlock` — that is the module being deferred,
 * and reaching it from here puts the highlighter back in the entry chunk.
 *
 * The remaining differences are the ones that cannot be avoided without
 * shipping the grammars: token colours, and the line-height Prism's theme
 * applies.
 */
import {
  CODE_BLOCK_DARK_BACKGROUND,
  CODE_BLOCK_FONT_FAMILY,
  CODE_BLOCK_FONT_SIZE,
  CODE_BLOCK_RADIUS,
  codeBlockPadding,
} from './codeBlockStyle';

export type PlainCodeBlockProps = {
  code: string;
  language: string;
  isDarkMode: boolean;
};

export default function PlainCodeBlock({ code, language, isDarkMode }: PlainCodeBlockProps) {
  return (
    <pre
      // Marks this as a transitional render rather than the final one.
      aria-busy="true"
      data-testid="plain-code-block"
      style={{
        margin: 0,
        borderRadius: CODE_BLOCK_RADIUS,
        fontSize: CODE_BLOCK_FONT_SIZE,
        padding: codeBlockPadding(language),
        overflowX: 'auto',
        background: isDarkMode ? CODE_BLOCK_DARK_BACKGROUND : 'hsl(var(--muted))',
        color: isDarkMode ? '#abb2bf' : 'inherit',
      }}
    >
      <code style={{ fontFamily: CODE_BLOCK_FONT_FAMILY, background: 'transparent' }}>{code}</code>
    </pre>
  );
}
