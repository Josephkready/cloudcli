import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { BulkArchivePrompt } from '../../utils/bulkArchivePrompt';

import BulkArchiveConfirmation from './BulkArchiveConfirmation';

// Return the English fallback so the button labels render their real text
// (mirrors SidebarHeader.test.tsx).
const t = ((key: string, fallback?: unknown) =>
  typeof fallback === 'string' ? fallback : key) as never;

const noop = () => {};

function render(prompt: BulkArchivePrompt | null): string {
  return renderToStaticMarkup(
    <BulkArchiveConfirmation prompt={prompt} onConfirm={noop} onCancel={noop} t={t} />,
  );
}

test('renders nothing when there is no active prompt', () => {
  assert.equal(render(null), '');
});

test('a confirm prompt shows the message plus Cancel and Archive actions', () => {
  const markup = render({
    kind: 'confirm',
    message: 'Archive 5 conversations idle for 30 days?',
  });
  assert.ok(markup.includes('Archive 5 conversations idle for 30 days?'), 'renders the prompt message');
  assert.ok(markup.includes('>Archive<'), 'renders the Archive confirm button');
  assert.ok(markup.includes('>Cancel<'), 'renders the Cancel button');
  // The dismiss-only affordance must not appear on a confirm prompt.
  assert.ok(!markup.includes('>OK<'), 'no OK button on a confirm prompt');
});

test('an inform prompt shows the message and only an OK dismiss action', () => {
  const markup = render({
    kind: 'inform',
    message: 'No conversations have been idle for more than 30 days.',
  });
  assert.ok(markup.includes('No conversations have been idle for more than 30 days.'));
  assert.ok(markup.includes('>OK<'), 'renders the OK dismiss button');
  // Destructive/confirm affordances must not appear when nothing qualifies.
  assert.ok(!markup.includes('>Archive<'), 'no Archive button on an inform prompt');
  assert.ok(!markup.includes('>Cancel<'), 'no Cancel button on an inform prompt');
});
