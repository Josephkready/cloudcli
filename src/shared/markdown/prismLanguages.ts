/**
 * The one Prism highlighter every markdown renderer in the app uses.
 *
 * WHY THIS MODULE EXISTS (issue #268)
 *   The package root export — `import { Prism } from 'react-syntax-highlighter'` —
 *   pulls in `refractor` *with all ~290 language grammars* (~870 KB of raw
 *   grammar source). `Markdown.tsx` is on the chat critical path, so that landed
 *   in the entry chunk and we shipped Brainfuck and ABAP grammars on every page
 *   load. `dist/esm/prism-light` instead builds on `refractor/core`, which
 *   bundles only markup/css/clike/javascript, and leaves grammar registration to
 *   the caller.
 *
 *   Registration lives here, in a single module both call sites import, so the
 *   chat renderer and the code-editor preview can never drift onto different
 *   language sets.
 *
 * ADDING A LANGUAGE
 *   Add an import + an entry in `LANGUAGE_GRAMMARS`. Anything not registered
 *   degrades to unhighlighted plain text (react-syntax-highlighter catches
 *   refractor's "Unknown language" throw), so an unknown fence never breaks a
 *   message — it just renders without colour.
 */
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
// Only one theme is ever on screen at a time, but the active one flips with the
// theme toggle, so both have to be reachable synchronously. Importing the two
// theme modules by path — rather than named exports off
// `dist/esm/styles/prism`, whose barrel re-exports ~40 themes — keeps every
// other theme out of the bundle even if tree-shaking regresses, and keeps the
// choice in one place instead of two components importing both.
// Deferring the inactive one further was measured and rejected: each theme is
// ~12 KB minified / ~1.8 KB gzipped, which does not buy the flash of uncoloured
// code a dynamic import would put in front of the first code block rendered.
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';

/**
 * The registered grammar set. Seeded from the languages the CodeMirror side
 * already supports (`vite.config.js`: css, html, javascript, json, markdown,
 * python) so the two highlighters agree, plus the languages this project's
 * assistant output actually contains.
 *
 * `markup` is Prism's name for the HTML/XML/SVG grammar; refractor registers
 * `html` (and `xml`, `svg`, …) as aliases of it automatically.
 */
const LANGUAGE_GRAMMARS = {
  bash,
  css,
  diff,
  go,
  javascript,
  json,
  jsx,
  markdown,
  markup,
  python,
  rust,
  sql,
  tsx,
  typescript,
  yaml,
} as const;

/**
 * Aliases refractor does not derive from the grammar itself. The grammars carry
 * their own common aliases (`ts`, `js`, `py`, `yml`, `md`, `shell`, `html`, …);
 * these are the extra spellings models reach for that would otherwise fall
 * through to plain text.
 */
const EXTRA_ALIASES: Record<string, string[]> = {
  bash: ['sh', 'zsh', 'shell-session', 'console'],
  go: ['golang'],
  rust: ['rs'],
};

let registered = false;

function registerLanguages(): void {
  if (registered) {
    return;
  }
  registered = true;

  for (const [name, grammar] of Object.entries(LANGUAGE_GRAMMARS)) {
    SyntaxHighlighter.registerLanguage(name, grammar);
  }
  for (const [name, aliases] of Object.entries(EXTRA_ALIASES)) {
    SyntaxHighlighter.alias(name, aliases);
  }
}

registerLanguages();

/** Canonical grammar names registered above (aliases not included). */
export const REGISTERED_PRISM_LANGUAGES: readonly string[] = Object.keys(LANGUAGE_GRAMMARS);

/** Extra alias spellings mapped onto a registered grammar. */
export const PRISM_LANGUAGE_ALIASES: Readonly<Record<string, readonly string[]>> = EXTRA_ALIASES;

/**
 * Pick the Prism theme for the current colour mode. Callers pass the value
 * through to `<PrismSyntaxHighlighter style={...} />`; keeping the choice here
 * means no component imports a theme (let alone both) directly.
 */
export function getPrismTheme(isDarkMode: boolean): Record<string, Record<string, string>> {
  return isDarkMode ? oneDark : oneLight;
}

export default SyntaxHighlighter;
