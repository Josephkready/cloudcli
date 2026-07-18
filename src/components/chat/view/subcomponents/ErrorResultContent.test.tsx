import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ErrorResultContent } from './ErrorResultContent';

// Regression coverage for #145: tool error/stderr output must be rendered as
// preformatted monospace text, NOT through the prose Markdown renderer (which
// collapses whitespace, turns leading `#`/`-`/`>` into headers/lists/quotes,
// and swallows `<...>` tokens). The raw diagnostic text must survive verbatim.

test('renders inside a <pre> so significant whitespace is preserved', () => {
  const html = renderToStaticMarkup(
    React.createElement(ErrorResultContent, { content: 'line 1\n    indented four spaces' }),
  );
  assert.match(html, /^<pre\b/);
  // The literal newline and run of spaces survive in the markup verbatim.
  assert.ok(html.includes('line 1\n    indented four spaces'));
});

test('does not turn leading `#` / `-` / `*` / numbered / `>` markers into headers, lists, or block-quotes', () => {
  const content = '# not a heading\n- not a list item\n* not a bullet\n1. not numbered\n> not a quote';
  const html = renderToStaticMarkup(
    React.createElement(ErrorResultContent, { content }),
  );
  assert.ok(!/<h[1-6]\b/.test(html), 'must not emit a heading element');
  assert.ok(!/<[uo]l\b/.test(html), 'must not emit a list container');
  assert.ok(!/<li\b/.test(html), 'must not emit a list item');
  assert.ok(!/<blockquote\b/.test(html), 'must not emit a block-quote');
  // The literal markers are preserved as text (`>` is HTML-escaped to `&gt;`).
  assert.ok(html.includes('# not a heading'));
  assert.ok(html.includes('- not a list item'));
  assert.ok(html.includes('* not a bullet'));
  assert.ok(html.includes('1. not numbered'));
  assert.ok(html.includes('&gt; not a quote'));
});

test('does not turn a `text\\n----` divider into a setext heading', () => {
  // A traceback banner underlined with dashes is valid setext-heading markdown;
  // the prose renderer would turn it into an <h2>. Preserve it verbatim.
  const content = 'Traceback\n---------\nsome error';
  const html = renderToStaticMarkup(
    React.createElement(ErrorResultContent, { content }),
  );
  assert.ok(!/<h[1-6]\b/.test(html), 'must not emit a heading element');
  assert.ok(html.includes('Traceback\n---------\nsome error'));
});

test('preserves angle-bracketed tokens like <anonymous> and Map<K,V>', () => {
  const html = renderToStaticMarkup(
    React.createElement(ErrorResultContent, {
      content: 'at <anonymous> (Map<K,V>)',
    }),
  );
  // Must stay in a raw <pre>, not a prose wrapper — the Markdown renderer also
  // escapes these tokens, so the escaped-text assertions below can't tell the two
  // apart on their own; pinning the <pre> root is what guards the regression.
  assert.match(html, /^<pre\b/);
  // Angle brackets survive as escaped literal text rather than being swallowed
  // as an unknown HTML tag / generic.
  assert.ok(html.includes('&lt;anonymous&gt;'));
  assert.ok(html.includes('Map&lt;K,V&gt;'));
});

test('preserves backtick-wrapped paths without converting to code spans', () => {
  const html = renderToStaticMarkup(
    React.createElement(ErrorResultContent, { content: 'in `/usr/lib/foo.js`' }),
  );
  assert.ok(!/<code\b/.test(html), 'must not emit an inline code span');
  assert.ok(html.includes('`/usr/lib/foo.js`'));
});
