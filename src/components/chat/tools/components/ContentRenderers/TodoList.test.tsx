import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import TodoList from './TodoList';

test('renders nothing for an empty todo list', () => {
  const html = renderToStaticMarkup(React.createElement(TodoList, { todos: [] }));
  assert.equal(html, '');
});

test('renders each todo item content', () => {
  const html = renderToStaticMarkup(
    React.createElement(TodoList, {
      todos: [
        { content: 'Write tests', status: 'pending' },
        { content: 'Ship it', status: 'in_progress' },
        { content: 'Celebrate', status: 'completed' },
      ],
    }),
  );
  assert.ok(html.includes('Write tests'));
  assert.ok(html.includes('Ship it'));
  assert.ok(html.includes('Celebrate'));
});

test('normalizes unknown statuses to pending', () => {
  const html = renderToStaticMarkup(
    React.createElement(TodoList, { todos: [{ content: 'Mystery', status: 'weird-status' }] }),
  );
  assert.ok(html.includes('Mystery'));
});

test('shows an item-count header only when isResult is true', () => {
  const withoutHeader = renderToStaticMarkup(
    React.createElement(TodoList, { todos: [{ content: 'a', status: 'pending' }] }),
  );
  assert.ok(!withoutHeader.includes('Todo List'));

  const withHeader = renderToStaticMarkup(
    React.createElement(TodoList, { todos: [{ content: 'a', status: 'pending' }], isResult: true }),
  );
  assert.ok(withHeader.includes('Todo List (1 item)'));

  const plural = renderToStaticMarkup(
    React.createElement(TodoList, {
      todos: [
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'pending' },
      ],
      isResult: true,
    }),
  );
  assert.ok(plural.includes('Todo List (2 items)'));
});

test('uses the provided id, falling back to content-index when absent', () => {
  const html = renderToStaticMarkup(
    React.createElement(TodoList, {
      todos: [
        { id: 'abc', content: 'has id', status: 'pending' },
        { content: 'no id', status: 'pending' },
      ],
    }),
  );
  assert.ok(html.includes('has id'));
  assert.ok(html.includes('no id'));
});
