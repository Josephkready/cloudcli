/**
 * Cheap "does this markdown actually contain LaTeX?" predicate (issue #269).
 *
 * KaTeX — the `remark-math` + `rehype-katex` plugins, the KaTeX runtime, and
 * ~18.6 KB of `.katex` rules in the render-blocking stylesheet — used to be wired
 * statically into every markdown render. In a coding assistant the overwhelming
 * majority of messages contain no math at all, so the whole chain is now loaded
 * on demand and this predicate is what decides.
 *
 * WHY NOT JUST `/\$\$?[^$]/`
 *   Because prose in a coding UI is full of dollar signs, and remark-math is
 *   greedy: "it costs $5 and $10 total" really does parse today as inline math
 *   with the body `5 and `, and renders as garbled KaTeX. A naive test would
 *   fire the lazy load on every such message and defeat the point. The rules
 *   below are deliberately stricter than remark-math's:
 *
 *     - Fenced blocks and inline code spans are removed first, so `${FOO}`,
 *       `$PATH`, and `$(cmd)` in shell snippets never count.
 *     - Escaped `\$` never opens or closes math.
 *     - An inline body may not start or end with whitespace, must stay on one
 *       line, and must look like math: either a "strong" signal (`\ ^ _ { }`),
 *       or a weak operator (`= < > + * / | ~`) alongside a letter, or a bare
 *       one/two-character symbol such as `x` or `a1`.
 *
 *   Consequence worth knowing: a message whose *only* dollars are prices — "it
 *   costs $5 and $10" — now renders as literal text instead of the broken math
 *   it produced before, because remark-math never gets loaded for it. A message
 *   that mixes real math with prices still hands the whole document to
 *   remark-math, so the prices are mangled there exactly as they always were;
 *   fixing that would mean replacing remark-math's tokeniser, not this file.
 *
 * Getting it wrong is cheap in one direction and not the other: a false
 * negative renders `$x$` as literal text (what a KaTeX-free build does anyway),
 * a false positive only costs an unnecessary lazy chunk fetch.
 */

/** ``` / ~~~ fenced blocks, including an unterminated trailing fence. */
const FENCED_CODE = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$))|[\s\S]*$)/g;

/** `code`, ``code with ` inside``, … */
const INLINE_CODE = /(`+)[\s\S]*?\1/g;

/** A backslash-escaped dollar is literal text, never a delimiter. */
const ESCAPED_DOLLAR = /\\\$/g;

/** Characters that only show up in real math notation. */
const STRONG_MATH_SIGNAL = /[\\^_{}]/;

/** Operators that appear in math but also in ordinary prose and currency. */
const WEAK_MATH_SIGNAL = /[=<>+*/|~]/;

const HAS_LETTER = /[A-Za-z]/;

/** `x`, `n`, `a1` — a bare symbol is plausible math, `5` or `10` is not. */
const BARE_SYMBOL = /^[A-Za-z][A-Za-z0-9]?$/;

/**
 * Remove everything a markdown renderer would treat as code, plus escaped
 * dollars, so only prose-level `$` delimiters remain.
 */
export function stripCodeSpans(markdown: string): string {
  return markdown
    .replace(FENCED_CODE, '$1')
    .replace(INLINE_CODE, ' ')
    .replace(ESCAPED_DOLLAR, ' ');
}

/** Would this delimited body plausibly be LaTeX rather than prose/currency? */
export function looksLikeMathBody(body: string): boolean {
  if (!body || /^\s/.test(body) || /\s$/.test(body)) {
    return false;
  }
  if (STRONG_MATH_SIGNAL.test(body)) {
    return true;
  }
  if (WEAK_MATH_SIGNAL.test(body) && HAS_LETTER.test(body)) {
    return true;
  }
  return BARE_SYMBOL.test(body);
}

/** `$$ … $$`, possibly spanning lines. A `$$` pair in prose is signal enough. */
function hasDisplayMath(text: string): boolean {
  const displayMath = /\$\$([\s\S]+?)\$\$/g;
  let match = displayMath.exec(text);
  while (match) {
    const body = match[1];
    if (/\S/.test(body) && !body.includes('$')) {
      return true;
    }
    match = displayMath.exec(text);
  }
  return false;
}

/**
 * `$ … $` on a single line. Hand-rolled rather than a regex so a rejected
 * candidate's closing `$` can be reconsidered as the *next* candidate's opener
 * — "$5 and $x^2$" must still find `x^2` after `5 and ` is thrown out.
 */
function hasInlineMath(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '$') {
      continue;
    }
    if (text[i + 1] === '$') {
      i += 1; // `$$` belongs to display math, handled separately.
      continue;
    }

    let close = -1;
    for (let j = i + 1; j < text.length; j += 1) {
      const char = text[j];
      if (char === '\n') {
        break;
      }
      if (char === '$') {
        close = j;
        break;
      }
    }
    if (close === -1) {
      continue;
    }

    if (looksLikeMathBody(text.slice(i + 1, close))) {
      return true;
    }
    i = close - 1; // resume *at* the closing `$`, which may open the next pair.
  }
  return false;
}

/**
 * True when `markdown` contains something `remark-math` + `rehype-katex` should
 * be loaded for. Runs on every rendered message, so it bails immediately on the
 * common case of no `$` at all.
 */
export function containsMath(markdown: string): boolean {
  if (!markdown || !markdown.includes('$')) {
    return false;
  }
  const prose = stripCodeSpans(markdown);
  if (!prose.includes('$')) {
    return false;
  }
  return hasDisplayMath(prose) || hasInlineMath(prose);
}
