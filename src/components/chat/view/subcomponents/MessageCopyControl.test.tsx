import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import MessageCopyControl from './MessageCopyControl';

// Coverage for #151: error/stderr tool-result boxes gained a copy affordance.
// The error variant must (1) render a copy button and (2) stay text-only — the
// markdown/text format dropdown is meaningless for raw stderr/stack traces and
// only appears for assistant messages. These render the real component to
// static markup and assert on the structure. (The clipboard payload itself is
// covered by the pure resolveCopyPayload tests in ../../utils/copyPayload.test.)

test('error variant renders a copy button', () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageCopyControl, {
      content: 'Traceback (most recent call last):\n  File "x.py"',
      messageType: 'error',
    }),
  );
  assert.match(html, /<button\b/, 'must render a clickable copy button');
});

test('error variant is text-only (no markdown/text format dropdown)', () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageCopyControl, {
      content: 'some stderr',
      messageType: 'error',
    }),
  );
  // The format-select trigger is only rendered for assistant messages; its
  // presence would mean the error box offers a nonsensical "Copy as markdown".
  assert.ok(!html.includes('Select copy format'), 'error box must not offer a format dropdown');
  // The default (and only) format for a non-assistant control is plain text.
  assert.ok(html.includes('TXT'), 'error copy control defaults to the plain-text format tag');
});

test('assistant variant DOES offer the format dropdown (guards the error/assistant split)', () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageCopyControl, {
      content: '# heading\n\nbody',
      messageType: 'assistant',
    }),
  );
  assert.ok(html.includes('Select copy format'), 'assistant messages keep the markdown/text dropdown');
});
