import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TodoListContent } from './TodoListContent';

test('renders nothing when todos is not an array', () => {
  const html = renderToStaticMarkup(React.createElement(TodoListContent, { todos: 'not-an-array' }));
  assert.equal(html, '');
});

test('renders nothing when todos is null/undefined', () => {
  assert.equal(renderToStaticMarkup(React.createElement(TodoListContent, { todos: null })), '');
  assert.equal(renderToStaticMarkup(React.createElement(TodoListContent, { todos: undefined })), '');
});

test('filters out malformed entries and renders only validated todo objects', () => {
  const html = renderToStaticMarkup(
    React.createElement(TodoListContent, {
      todos: [
        { content: 'valid one', status: 'pending' },
        { content: 'missing status' },
        { status: 'pending' },
        null,
        'oops',
        42,
        { content: 'valid two', status: 'completed' },
      ],
    }),
  );
  assert.ok(html.includes('valid one'));
  assert.ok(html.includes('valid two'));
  assert.ok(!html.includes('missing status'));
});

test('renders nothing when all entries are malformed', () => {
  const html = renderToStaticMarkup(
    React.createElement(TodoListContent, { todos: [null, 'oops', { content: 1, status: 2 }] }),
  );
  assert.equal(html, '');
});

test('passes isResult through to TodoList', () => {
  const html = renderToStaticMarkup(
    React.createElement(TodoListContent, {
      todos: [{ content: 'a', status: 'pending' }],
      isResult: true,
    }),
  );
  assert.ok(html.includes('Todo List (1 item)'));
});
