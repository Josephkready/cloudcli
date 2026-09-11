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
 *
 * MEMOIZED ON PURPOSE. `SyntaxHighlighter` re-tokenizes and re-highlights
 * `code` synchronously as part of rendering — it does no memoization of its
 * own — so an unmemoized `PrismCodeBlock` re-runs Prism from scratch on every
 * render of its parent, even when `code`/`language`/`isDarkMode` haven't
 * changed. A CPU profile of `chat_turn_in_large_conversation` (see
 * docs/ARCHITECTURE-ASSESSMENT-2026-09.md §4.2) found Prism to be the largest
 * attributable JS cost during a live stream into a code-heavy conversation.
 * All three props here are primitives, so the default shallow comparison
 * `memo()` uses is exactly the right equality check — no custom comparator
 * needed — and this closes off one real source of redundant highlighting: an
 * already-rendered code block whose message is re-rendered for an unrelated
 * reason (a sibling's identity churn, a parent prop change) no longer pays a
 * second Prism pass for content that has not changed.
 *
 * WHAT THIS DOES NOT FIX: a fenced code block belonging to the message that
 * is *itself* actively streaming still gets a genuinely different `code`
 * value on every tick (more of the fence has arrived), so memo correctly
 * lets those re-highlights through — measured before/after this change, most
 * of the profiled Prism cost in a single-code-block reply turned out to be
 * this streaming-fence cost, not the redundant-sibling cost, so the net
 * effect on that specific benchmark was real but modest (see the doc for the
 * numbers). Bounding the streaming-fence cost itself is tracked separately
 * (assessment doc, option A5) since it needs the same kind of
 * fence-completeness gating `mermaidFences.ts` already does for diagrams.
 */
import { memo } from 'react';

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

function PrismCodeBlock({ code, language, isDarkMode }: PrismCodeBlockProps) {
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

export default memo(PrismCodeBlock);
