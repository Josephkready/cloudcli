/**
 * Everything mermaid, isolated into a chunk nothing imports statically.
 *
 * This is the mermaid twin of `mathRuntime.ts`, and it exists for the same
 * reason: mermaid is the largest dependency in this app — bigger than Prism's
 * grammars (#268) and bigger than KaTeX (#269) — and a single
 * `import mermaid from 'mermaid'` anywhere the entry reaches would put all of it
 * (d3, dagre, cytoscape, langium, its own copy of KaTeX) on the boot path for
 * every session, the overwhelming majority of which contain no diagram at all.
 *
 * The only edge into this module is `import('./mermaidRuntime')` in
 * `mermaidRuntimeLoader.ts`. Do not import it from anywhere reachable statically
 * from `src/main.jsx` — `src/test/entryStaticImports.test.ts` and
 * `scripts/check-entry-chunk.mjs` both fail if that happens, the first against
 * the source graph and the second against the built bundle.
 */
import mermaid from 'mermaid';

import { mermaidInitConfig } from './mermaidConfig';

export type RenderMermaidOptions = {
  /** Diagram source, already trimmed. */
  code: string;
  /** CSS-safe id; mermaid derives DOM ids and selectors from it. */
  id: string;
  /** Drives which built-in mermaid palette is used. */
  isDarkMode: boolean;
};

/**
 * Renders are serialised.
 *
 * `mermaid.initialize()` mutates one module-global config and `mermaid.render()`
 * attaches a temporary element to the document while it measures text, so two
 * overlapping calls can read each other's theme or each other's scratch DOM. A
 * message with several diagrams mounts them all in the same commit, so this is
 * the common case, not a corner one.
 */
let queue: Promise<unknown> = Promise.resolve();

async function renderOne({ code, id, isDarkMode }: RenderMermaidOptions): Promise<string | null> {
  mermaid.initialize(mermaidInitConfig(isDarkMode));

  // Parse first, and treat "does not parse" as a value rather than a throw.
  // `suppressErrors` keeps mermaid from logging a stack for what is, in a chat
  // transcript, an entirely routine event: a model wrote invalid mermaid.
  const parsed = await mermaid.parse(code, { suppressErrors: true });
  if (!parsed) {
    return null;
  }

  const { svg } = await mermaid.render(id, code);
  return svg;
}

/**
 * Render `code` to an SVG string, or `null` when it is not a valid diagram.
 *
 * Never throws for bad input — bad input is the expected case. A rejection here
 * means mermaid itself failed (a rendering bug, a diagram type that parses but
 * cannot draw), which the caller also treats as "show the source instead".
 *
 * The returned markup is safe to inject: `securityLevel: 'strict'` makes mermaid
 * run its output through DOMPurify and strips scripts and event handlers before
 * it is handed back.
 */
export function renderMermaid(options: RenderMermaidOptions): Promise<string | null> {
  const run = queue.then(() => renderOne(options));
  // The queue must survive a failed render, so it chains on the settled promise
  // rather than on `run` itself.
  queue = run.catch(() => undefined);
  return run;
}
