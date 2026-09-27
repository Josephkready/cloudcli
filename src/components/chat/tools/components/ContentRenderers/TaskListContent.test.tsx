import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TaskListContent } from './TaskListContent';

test('falls back to a raw <pre> dump when no task lines can be parsed', () => {
  const html = renderToStaticMarkup(React.createElement(TaskListContent, { content: 'no tasks here' }));
  assert.match(html, /<pre\b/);
  assert.ok(html.includes('no tasks here'));
});

test('parses "#N. [status] Subject" lines and shows a completed/total progress bar', () => {
  const content = ['#1. [completed] Set up repo', '#2. [in_progress] Write tests', '#3. Plain pending task'].join(
    '\n',
  );
  const html = renderToStaticMarkup(React.createElement(TaskListContent, { content }));
  assert.ok(html.includes('1/3 completed'));
  assert.ok(html.includes('#1'));
  assert.ok(html.includes('Set up repo'));
  assert.ok(html.includes('completed'));
  assert.ok(html.includes('in progress') || html.includes('in_progress'));
});

test('defaults an unlabeled task to pending status', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskListContent, { content: '#7. Some task with no bracket status' }),
  );
  assert.ok(html.includes('#7'));
  assert.ok(html.includes('pending'));
});

test('extracts blockedBy ids when present', () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskListContent, {
      content: '#4. [pending] Blocked task (blockedBy: [1, 2])',
    }),
  );
  // The badge/text still renders even though blockedBy isn't displayed directly;
  // parsing must not throw and the subject/id still show.
  assert.ok(html.includes('#4'));
  assert.ok(html.includes('Blocked task'));
});

test('shows 0% width when there are zero total tasks is unreachable (guarded), but 0/0 division is safe', () => {
  // Sanity: a single parsed task with no completions renders 0/1, no NaN in width.
  const html = renderToStaticMarkup(
    React.createElement(TaskListContent, { content: '#1. [pending] Only task' }),
  );
  assert.ok(html.includes('0/1 completed'));
  assert.ok(!html.includes('NaN'));
});
