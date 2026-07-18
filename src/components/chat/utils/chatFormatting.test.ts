import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeHtmlEntities,
  normalizeInlineCodeFences,
  unescapeWithMathProtection,
  escapeRegExp,
  formatUsageLimitText,
} from './chatFormatting';

// Pure string-formatting helpers used throughout chat message rendering. They
// had no coverage; these pin the exact (and occasionally surprising) behavior.

test('decodeHtmlEntities decodes the five supported entities', () => {
  assert.equal(decodeHtmlEntities('&lt;div&gt;'), '<div>');
  assert.equal(decodeHtmlEntities('&quot;hi&quot; &#39;yo&#39; a&amp;b'), '"hi" \'yo\' a&b');
});

test('decodeHtmlEntities is single-pass — &amp; is decoded last, no cascade', () => {
  // `&amp;lt;` must NOT become `<`: at the time `&lt;` is scanned the literal
  // `&lt;` is not present yet, and `&amp;`->`&` runs afterwards. So one level.
  assert.equal(decodeHtmlEntities('&amp;lt;'), '&lt;');
});

test('decodeHtmlEntities returns falsy input unchanged', () => {
  assert.equal(decodeHtmlEntities(''), '');
});

test('normalizeInlineCodeFences collapses a single-line triple-fence to one backtick', () => {
  assert.equal(normalizeInlineCodeFences('```bash```'), '`bash`');
  // Surrounding spaces/tabs inside the fence are trimmed.
  assert.equal(normalizeInlineCodeFences('```  hi  ```'), '`hi`');
});

test('normalizeInlineCodeFences leaves multi-line fenced blocks alone', () => {
  const block = '```\ncode\n```';
  assert.equal(normalizeInlineCodeFences(block), block);
  assert.equal(normalizeInlineCodeFences(''), '');
});

test('unescapeWithMathProtection turns literal \\n \\t \\r into real whitespace', () => {
  assert.equal(unescapeWithMathProtection('line1\\nline2'), 'line1\nline2');
  assert.equal(unescapeWithMathProtection('a\\tb\\rc'), 'a\tb\rc');
});

test('unescapeWithMathProtection preserves escapes inside $...$ and $$...$$ math', () => {
  // Inline math is protected: the backslash-n stays literal inside it.
  assert.equal(unescapeWithMathProtection('$a\\nb$'), '$a\\nb$');
  // Outside math unescapes; inside is preserved verbatim.
  assert.equal(unescapeWithMathProtection('x\\ny $z\\nw$'), 'x\ny $z\\nw$');
  // Display math ($$...$$) is likewise protected.
  assert.equal(unescapeWithMathProtection('$$k\\nv$$'), '$$k\\nv$$');
});

test('escapeRegExp escapes regex metacharacters and leaves ordinary chars', () => {
  assert.equal(escapeRegExp('a.b*c'), 'a\\.b\\*c');
  assert.equal(escapeRegExp('(x)[y]{z}'), '\\(x\\)\\[y\\]\\{z\\}');
  assert.equal(escapeRegExp('1+1=2?'), '1\\+1=2\\?');
});

test('formatUsageLimitText passes through non-matching / non-string input', () => {
  assert.equal(formatUsageLimitText('just a normal message'), 'just a normal message');
  assert.equal(formatUsageLimitText(123 as unknown as string), 123 as unknown as string);
});

test('formatUsageLimitText ignores markers whose digit count is out of the 10-13 range', () => {
  // The marker regex requires \d{10,13}; a short numeric tail must not match.
  const short = 'Claude AI usage limit reached|123';
  assert.equal(formatUsageLimitText(short), short);
});

test('formatUsageLimitText rewrites the "reached|<ts>" marker into human text', () => {
  // 1700000000 s = mid-November 2023 UTC; the day/time are timezone-dependent so
  // we assert only timezone-robust substrings (mid-month keeps the month stable).
  const secs = formatUsageLimitText('Claude AI usage limit reached|1700000000');
  assert.notEqual(secs, 'Claude AI usage limit reached|1700000000');
  assert.ok(secs.includes('Claude usage limit reached. Your limit will reset at **'));
  assert.ok(secs.includes('Nov 2023'), `expected Nov 2023 in: ${secs}`);
  assert.ok(!secs.includes('reached|1700000000'), 'raw marker must be gone');

  // A 13-digit millisecond timestamp resolves to the same instant (no *1000).
  const ms = formatUsageLimitText('Claude AI usage limit reached|1700000000000');
  assert.ok(ms.includes('Nov 2023'), `expected Nov 2023 in: ${ms}`);
});
