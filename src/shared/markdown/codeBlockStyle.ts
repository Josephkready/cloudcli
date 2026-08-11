/**
 * Metrics shared by the highlighted code block and its loading stand-in (#287).
 *
 * These live in a module of their own for a load-bearing reason: `PlainCodeBlock`
 * is the fallback rendered WHILE the Prism bundle downloads, so it must not
 * reach Prism itself. Importing these constants from `PrismCodeBlock` — the
 * obvious way to avoid duplicating them — put the highlighter and all fifteen
 * grammars straight back into the entry chunk through the fallback, which is
 * the exact regression the split exists to prevent.
 *
 * So: values here, no imports, and both components depend on this instead of on
 * each other.
 */

/**
 * Padding leaves room for the language label the caller absolutely-positions
 * over the top-left corner; a block with no language gets the plain inset.
 */
export function codeBlockPadding(language: string): string {
  return language && language !== 'text' ? '2rem 1rem 1rem 1rem' : '1rem';
}

export const CODE_BLOCK_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export const CODE_BLOCK_RADIUS = '0.75rem';
export const CODE_BLOCK_FONT_SIZE = '0.875rem';

/** oneDark's own background, matched by the fallback so the swap doesn't flash. */
export const CODE_BLOCK_DARK_BACKGROUND = '#282c34';
