import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCopyPayload, convertMarkdownToPlainText } from './copyPayload';

// resolveCopyPayload decides the exact clipboard text for a copy control. The
// error path is the crux of #151: raw stderr/stack traces must be copied
// verbatim, never run through the markdown→plain-text stripper (fine for prose,
// destructive for diagnostic text).

test('error content is copied verbatim — markdown-looking tokens survive', () => {
  // Every token here is one convertMarkdownToPlainText would corrupt: angle-bracket
  // frames, backtick paths, leading `#`/`-`/`>` markers, and a run of blank lines.
  const stderr =
    'Traceback:\n' +
    '  at <anonymous> (Map<K,V>)\n' +
    '  in `/usr/lib/foo.js`\n' +
    '# not a heading\n' +
    '- not a list item\n' +
    '> not a quote\n\n\n' +
    'end';
  // messageType wins over format — even asked for 'text', error stays raw.
  assert.equal(resolveCopyPayload(stderr, 'text', 'error'), stderr);
  // Sanity check that the stripper really would have mangled it (guards against
  // the assertion above passing only because the stripper became a no-op).
  assert.notEqual(convertMarkdownToPlainText(stderr), stderr);
});

test('non-error text format strips markdown', () => {
  assert.equal(resolveCopyPayload('# hi', 'text', 'user'), 'hi');
});

test('markdown format returns content verbatim', () => {
  assert.equal(resolveCopyPayload('# hi', 'markdown', 'assistant'), '# hi');
});

test('convertMarkdownToPlainText deletes angle-bracket tokens (why error must bypass it)', () => {
  assert.equal(convertMarkdownToPlainText('at <anonymous>'), 'at');
});

test('error content is returned untrimmed (verbatim), unlike the stripper', () => {
  // The stripper trims; the error path must NOT — leading/trailing whitespace in
  // stderr (indentation, trailing newline) is part of the verbatim output.
  const padded = '   \n  indented\n  ';
  assert.equal(resolveCopyPayload(padded, 'text', 'error'), padded);
});

test('empty and whitespace-only input', () => {
  assert.equal(resolveCopyPayload('', 'text', 'error'), '');
  // Non-error whitespace collapses to '' via the stripper's trailing .trim().
  assert.equal(resolveCopyPayload('   \n  ', 'text', 'user'), '');
});
