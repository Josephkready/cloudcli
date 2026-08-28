/**
 * Which fenced blocks are mermaid, and which of them are finished arriving.
 *
 * Two separate questions, both answered here because both are pure string work
 * and both are load-bearing for how a diagram renders:
 *
 * 1. IS THIS FENCE MERMAID? Not as simple as it looks. `Markdown.tsx` derives
 *    its language badge from `/language-(\w+)/`, and `\w` does not match `-`, so
 *    a ```` ```mermaid-something ```` fence reports its language as `mermaid`.
 *    Handing that to the renderer would turn an unrelated block into a diagram,
 *    so the mermaid decision reads the class list directly and demands an exact
 *    `language-mermaid` token — ```` ```mermaidjs ```` and
 *    ```` ```mermaid-something ```` are ordinary code blocks.
 *
 * 2. HAS THE FENCE CLOSED? An assistant message streams in a token at a time, so
 *    for most of a diagram's life the source is a prefix of itself. Markdown
 *    still yields a `code` node for an unterminated fence (CommonMark closes one
 *    at end of document), which means the renderer sees a half-written diagram
 *    and would try to draw it. Some prefixes fail to parse and some parse into a
 *    *different, wrong* diagram, so either way the reader watches the picture
 *    flicker and rearrange on every token. Scanning the raw markdown for the
 *    closing fence is the only way to tell "broken" from "not finished yet".
 *
 * No imports on purpose: this is reached from the eager chat path, and the whole
 * point of the mermaid split is that nothing eager touches the library.
 */

/** A fenced block found in the markdown source. */
export type FenceInfo = {
  /** Lower-cased first word of the info string (`ts`, `mermaid`, `''`). */
  language: string;
  /** Fence contents, dedented by the opener's own indent, no trailing newline. */
  body: string;
  /** True when a matching closing fence was found before end of input. */
  closed: boolean;
};

/** Up to three spaces of indent, then three-or-more backticks or tildes. */
const FENCE_OPENER = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** The class react-markdown puts on a ```` ```mermaid ```` block's `<code>`. */
const MERMAID_CLASS = 'language-mermaid';

/**
 * True for the exact info string `mermaid` (case- and whitespace-insensitive),
 * and for nothing else. `mermaidjs` and `mermaid-something` are other languages.
 */
export function isMermaidLanguage(language?: string | null): boolean {
  return typeof language === 'string' && language.trim().toLowerCase() === 'mermaid';
}

/**
 * True when a `<code>` element's className marks it as a mermaid fence.
 *
 * Takes the className rather than the parsed language because the parsed
 * language is lossy (see the `\w` note above). react-markdown hands className
 * through as an array; a string is accepted too so the helper is usable against
 * raw HTML props.
 */
export function isMermaidClassName(className?: unknown): boolean {
  const classes = Array.isArray(className)
    ? className
    : typeof className === 'string'
      ? className.split(/\s+/)
      : [];
  return classes.some((entry) => typeof entry === 'string' && entry.trim().toLowerCase() === MERMAID_CLASS);
}

/** CommonMark strips up to the opener's indent from each content line. */
function stripIndent(line: string, indent: number): string {
  let removed = 0;
  while (removed < indent && line[removed] === ' ') {
    removed += 1;
  }
  return line.slice(removed);
}

/**
 * Is this line a closing fence for an opener made of `marker`?
 *
 * A closer uses the same character, is at least as long as the opener, and
 * carries nothing but whitespace after it.
 */
function isFenceCloser(line: string, marker: string): boolean {
  const withoutIndent = line.replace(/^ {0,3}/, '');
  const fenceChar = marker[0];
  let run = 0;
  while (run < withoutIndent.length && withoutIndent[run] === fenceChar) {
    run += 1;
  }
  return run >= marker.length && withoutIndent.slice(run).trim() === '';
}

/**
 * Every fenced block in `markdown`, in order, each flagged as closed or not.
 *
 * Deliberately a line scanner rather than a regex: the "did it close" answer is
 * the entire reason this exists, and a regex that has to express "same fence
 * character, at least as long, or else run to end of input" is unreadable and
 * easy to get subtly wrong.
 */
export function scanFences(markdown: string): FenceInfo[] {
  const lines = String(markdown ?? '').split('\n');
  const fences: FenceInfo[] = [];

  let index = 0;
  while (index < lines.length) {
    const opener = FENCE_OPENER.exec(lines[index]);
    if (!opener) {
      index += 1;
      continue;
    }

    const [, indent, marker, info] = opener;
    // CommonMark: a backtick fence's info string may not contain a backtick,
    // which is what keeps `` `a` `` and ```` ```x``` ```` from opening fences.
    if (marker[0] === '`' && info.includes('`')) {
      index += 1;
      continue;
    }

    const language = (info.trim().split(/\s+/)[0] || '').toLowerCase();
    const body: string[] = [];
    let closed = false;
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (isFenceCloser(lines[cursor], marker)) {
        closed = true;
        break;
      }
      body.push(stripIndent(lines[cursor], indent.length));
    }

    fences.push({ language, body: body.join('\n'), closed });
    index = closed ? cursor + 1 : cursor;
  }

  return fences;
}

/**
 * Trailing whitespace is the one difference between the source we scan and the
 * text react-markdown hands the renderer (hast appends a newline to a fence's
 * text child), so it is normalised away before the two are compared.
 */
function fenceKey(body: string): string {
  return String(body ?? '').replace(/\s+$/, '');
}

/**
 * Build the "is this diagram finished streaming?" predicate for one message.
 *
 * The predicate is keyed on the fence body rather than on position because
 * react-markdown gives the renderer text, not source offsets, and because body
 * text is stable across the re-renders a streaming message causes.
 *
 * Unknown bodies answer `true`. That direction is chosen on purpose: a scanner
 * miss then costs at most one failed parse (which falls back to showing the
 * source anyway), whereas answering `false` would mean a diagram this scanner
 * failed to recognise never renders at all.
 */
export function createMermaidFenceGate(markdown: string): (code: string) => boolean {
  const closed = new Set<string>();
  const unclosed = new Set<string>();

  for (const fence of scanFences(markdown)) {
    if (!isMermaidLanguage(fence.language)) {
      continue;
    }
    (fence.closed ? closed : unclosed).add(fenceKey(fence.body));
  }

  return (code: string) => {
    const key = fenceKey(code);
    // A body that appears closed somewhere is renderable, even if an identical
    // one is still streaming further down: the closed copy proves it parses.
    //
    // The cost of that shortcut, for honesty: if a message repeats the SAME
    // diagram twice and the second copy is mid-stream, the second one is
    // rendered on each token until it closes — the flicker this gate exists to
    // prevent, for the one case where the text is byte-identical. Bounded (it
    // still falls back to source on a failed parse) and rare enough to be worth
    // keeping the shortcut, which is what lets a repeated diagram render at all.
    if (closed.has(key)) {
      return true;
    }
    return !unclosed.has(key);
  };
}

/** The gate used when no message context is available: render everything. */
export const ALWAYS_COMPLETE = (): boolean => true;
