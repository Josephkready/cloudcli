import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeHtmlEntities,
  normalizeInlineCodeFences,
  unescapeWithMathProtection,
  escapeRegExp,
  formatUsageLimitText,
} from './chatFormatting';

// Pure formatting helpers used across the chat render path (Markdown
// pre-processing + the assistant/tool message pipeline). No DOM — assert on
// concrete transformed strings and edge cases.

test('decodeHtmlEntities decodes the five supported entities', () => {
  assert.equal(decodeHtmlEntities('&lt;a&gt; &amp; &quot;x&quot; &#39;y&#39;'), `<a> & "x" 'y'`);
});

test('decodeHtmlEntities decodes &amp; last so escaped entities survive one pass', () => {
  // `&amp;lt;` is an escaped `&lt;`. Decoding &amp; last yields `&lt;`, not `<`
  // (i.e. entities are not double-decoded).
  assert.equal(decodeHtmlEntities('&amp;lt;'), '&lt;');
});

test('decodeHtmlEntities guards falsy input (would throw on null without the guard)', () => {
  assert.equal(decodeHtmlEntities(''), '');
  // No try/catch here: without the `if (!text)` guard, `null.replace` would throw,
  // so this genuinely exercises the guard rather than a no-op.
  assert.equal(decodeHtmlEntities(null as unknown as string), null);
});

test('normalizeInlineCodeFences collapses a single-line triple-fence to inline code', () => {
  assert.equal(normalizeInlineCodeFences('use ```npm test``` now'), 'use `npm test` now');
  // Trims padding inside the fence.
  assert.equal(normalizeInlineCodeFences('```  spaced  ```'), '`spaced`');
});

test('normalizeInlineCodeFences leaves a real multi-line fenced block alone', () => {
  const block = '```\nline1\nline2\n```';
  assert.equal(normalizeInlineCodeFences(block), block);
});

test('normalizeInlineCodeFences collapses every single-line fence (global replace)', () => {
  assert.equal(normalizeInlineCodeFences('```a``` and ```b```'), '`a` and `b`');
});

test('normalizeInlineCodeFences returns non-strings unchanged', () => {
  assert.equal(normalizeInlineCodeFences(undefined as unknown as string), undefined);
});

test('unescapeWithMathProtection turns escaped whitespace into real whitespace', () => {
  assert.equal(unescapeWithMathProtection('a\\nb\\tc\\rd'), 'a\nb\tc\rd');
});

test('unescapeWithMathProtection preserves backslash sequences inside $...$ / $$...$$ math', () => {
  // The `\n` inside the inline math span must stay literal; the one outside is unescaped.
  assert.equal(unescapeWithMathProtection('$a\\nb$ then\\nout'), '$a\\nb$ then\nout');
  const display = 'pre\\n$$x\\ty$$\\npost';
  assert.equal(unescapeWithMathProtection(display), 'pre\n$$x\\ty$$\npost');
});

test('unescapeWithMathProtection returns non-strings unchanged', () => {
  assert.equal(unescapeWithMathProtection(null as unknown as string), null);
});

test('empty string is a no-op / early return across the helpers', () => {
  assert.equal(normalizeInlineCodeFences(''), '');
  assert.equal(unescapeWithMathProtection(''), '');
  assert.equal(formatUsageLimitText(''), '');
  assert.equal(escapeRegExp(''), '');
});

test('escapeRegExp escapes all regex metacharacters', () => {
  assert.equal(escapeRegExp('a.b*c+d?(e)[f]{g}|h^i$j\\k'), 'a\\.b\\*c\\+d\\?\\(e\\)\\[f\\]\\{g\\}\\|h\\^i\\$j\\\\k');
  // The escaped output must match the original text literally when used in a RegExp.
  const raw = 'v1.2.3 (build)';
  assert.ok(new RegExp(escapeRegExp(raw)).test(raw));
});

test('formatUsageLimitText rewrites the raw limit marker into a human sentence', () => {
  // 10-digit (seconds) epoch — the function multiplies by 1000.
  const out = formatUsageLimitText('Claude AI usage limit reached|1700000000');
  assert.notEqual(out, 'Claude AI usage limit reached|1700000000');
  assert.match(out, /^Claude usage limit reached\. Your limit will reset at \*\*.+\*\* - .+2023$/);
  // The raw machine marker must be gone.
  assert.ok(!out.includes('Claude AI usage limit reached|'));
});

test('formatUsageLimitText accepts a 13-digit millisecond epoch', () => {
  const out = formatUsageLimitText('Claude AI usage limit reached|1700000000000');
  assert.match(out, /reset at \*\*.+\*\* - .+2023$/);
});

test('formatUsageLimitText rewrites every occurrence', () => {
  const out = formatUsageLimitText(
    'first Claude AI usage limit reached|1700000000 second Claude AI usage limit reached|1700000000',
  );
  assert.equal(out.match(/Claude usage limit reached\./g)?.length, 2);
  assert.ok(!out.includes('Claude AI usage limit reached|'));
});

test('formatUsageLimitText leaves text without the marker untouched', () => {
  assert.equal(formatUsageLimitText('just a normal message'), 'just a normal message');
});

test('formatUsageLimitText falls back to the raw text when formatting throws', () => {
  // Force the inner date formatting to throw so the try/catch fallback runs; the
  // matched marker must survive verbatim rather than the message being dropped.
  const intl = Intl as { DateTimeFormat: unknown };
  const original = intl.DateTimeFormat;
  intl.DateTimeFormat = () => {
    throw new Error('boom');
  };
  try {
    const input = 'Claude AI usage limit reached|1700000000';
    assert.equal(formatUsageLimitText(input), input);
  } finally {
    intl.DateTimeFormat = original;
  }
});
