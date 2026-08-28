/**
 * Mermaid's settings, kept in a module that never loads mermaid.
 *
 * `mermaidRuntime.ts` is the only file allowed to import the library, and it is
 * only ever reached through a dynamic `import()`. Everything here is plain data
 * and string work, so it can be unit-tested by `tsx --test` (which cannot load
 * mermaid's ESM build) and imported from the eager chat path without dragging
 * ~1 MB of diagram engine into the entry chunk.
 *
 * The `import type` below is erased by TypeScript and is invisible to the
 * bundler — `src/test/entryStaticImports.test.ts` proves that, and would fail
 * the moment it stopped being type-only.
 */
import type { MermaidConfig } from 'mermaid';

export type MermaidTheme = 'dark' | 'default';

/**
 * Mermaid ships one palette designed for light backgrounds (`default`) and one
 * for dark (`dark`). Leaving it on `default` in dark mode is the illegible case:
 * near-black text on the diagram's own pale node fills, against the app's dark
 * surface.
 */
export function mermaidTheme(isDarkMode: boolean): MermaidTheme {
  return isDarkMode ? 'dark' : 'default';
}

/**
 * Mermaid builds DOM ids and CSS selectors out of the render id, so it has to be
 * a valid CSS identifier. React's `useId()` produces values like `:r7:`, whose
 * colons make mermaid's own selector lookups throw — strip anything that is not
 * safe in an identifier, and keep a constant fallback for a seed that is left
 * with nothing.
 */
export function mermaidDiagramId(seed: string): string {
  const cleaned = String(seed ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  return `mermaid-${cleaned || 'diagram'}`;
}

/**
 * `useMaxWidth: false` is the layout decision, applied per diagram type because
 * mermaid has no global switch for it.
 *
 * With the default (`true`) mermaid emits `width="100%"` plus a `max-width`
 * style, so a wide diagram silently shrinks to the width of the chat column and
 * becomes unreadable. Switching it off makes mermaid emit the diagram's natural
 * pixel width, which the renderer's `overflow-x-auto` container then scrolls —
 * the diagram stays legible and the transcript never gains a horizontal
 * scrollbar of its own.
 */
const NATURAL_WIDTH = { useMaxWidth: false } as const;

/**
 * The config handed to `mermaid.initialize()` before every render.
 *
 * - `startOnLoad: false` — nothing may scan the document for diagrams; this app
 *   renders each one explicitly, by id.
 * - `securityLevel: 'strict'` — mermaid's own default. Diagram source is model
 *   output, so click handlers and inline HTML stay off and the produced markup
 *   is run through DOMPurify before we ever see it.
 * - `suppressErrorRendering: true` — without it a malformed diagram makes
 *   mermaid inject its own red "Syntax error" bomb graphic into the document.
 *   Agents emit malformed mermaid routinely, and the fallback here is to show
 *   the source instead, so mermaid must not be drawing anything on failure.
 */
export function mermaidInitConfig(isDarkMode: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: mermaidTheme(isDarkMode),
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    flowchart: NATURAL_WIDTH,
    sequence: NATURAL_WIDTH,
    class: NATURAL_WIDTH,
    state: NATURAL_WIDTH,
    er: NATURAL_WIDTH,
    gantt: NATURAL_WIDTH,
    journey: NATURAL_WIDTH,
    pie: NATURAL_WIDTH,
    gitGraph: NATURAL_WIDTH,
    mindmap: NATURAL_WIDTH,
    timeline: NATURAL_WIDTH,
    requirement: NATURAL_WIDTH,
  };
}
