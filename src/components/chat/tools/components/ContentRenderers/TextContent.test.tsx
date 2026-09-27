import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TextContent } from './TextContent';

test('renders plain text (default format) preserving content', () => {
  const html = renderToStaticMarkup(React.createElement(TextContent, { content: 'hello\nworld' }));
  assert.match(html, /<div\b/);
  assert.ok(html.includes('hello'));
});

test('renders code format in a <pre>/<code>-style monospace block', () => {
  const html = renderToStaticMarkup(React.createElement(TextContent, { content: 'const x = 1;', format: 'code' }));
  assert.match(html, /<pre\b/);
  assert.ok(html.includes('const x = 1;'));
});

test('renders valid JSON pretty-printed', () => {
  const html = renderToStaticMarkup(
    React.createElement(TextContent, { content: JSON.stringify({ a: 1, b: [2, 3] }), format: 'json' }),
  );
  assert.ok(html.includes('&quot;a&quot;: 1') || html.includes('"a": 1'));
});

test('falls back to the raw string when JSON parsing fails', () => {
  const html = renderToStaticMarkup(
    React.createElement(TextContent, { content: 'not valid json {', format: 'json' }),
  );
  assert.ok(html.includes('not valid json'));
});

test('applies a custom className to plain text', () => {
  const html = renderToStaticMarkup(
    React.createElement(TextContent, { content: 'x', className: 'my-extra' }),
  );
  assert.ok(html.includes('my-extra'));
});
