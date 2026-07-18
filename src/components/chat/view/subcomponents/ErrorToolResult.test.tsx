import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ErrorToolResult } from './ErrorToolResult';

// Coverage for #151: the error box shows a copy control only when there is
// error content to copy, and always renders the error body itself. Renders the
// real box (extracted from MessageComponent precisely so it's testable without
// the Markdown/syntax-highlighter import chain).

test('renders the copy control when there is error content', () => {
  const html = renderToStaticMarkup(
    React.createElement(ErrorToolResult, { content: 'Traceback: at <anonymous>', toolId: 't1' }),
  );
  // Body renders the stderr verbatim (angle brackets HTML-escaped, not swallowed).
  assert.ok(html.includes('&lt;anonymous&gt;'), 'error body renders the stderr verbatim');
  // The copy control is the only <button> in this box.
  assert.match(html, /<button\b/, 'copy control appears for non-empty error content');
});

test('hides the copy control for whitespace-only content but still renders the box', () => {
  const html = renderToStaticMarkup(
    React.createElement(ErrorToolResult, { content: '   \n  ', toolId: 't1' }),
  );
  assert.match(html, /<pre\b/, 'the error box body still renders');
  assert.ok(!html.includes('<button'), 'no copy control when there is nothing worth copying');
});

test('hides the copy control for empty content', () => {
  const html = renderToStaticMarkup(
    React.createElement(ErrorToolResult, { content: '', toolId: 't1' }),
  );
  assert.ok(!html.includes('<button'), 'no copy control for empty content');
});
