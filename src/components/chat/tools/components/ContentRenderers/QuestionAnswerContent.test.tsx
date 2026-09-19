import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestionAnswerContent } from './QuestionAnswerContent';

// Regression coverage for the chat-interface crash where an AskUserQuestion
// payload loaded from a session transcript arrives with a non-array `questions`
// or a question missing its `options` array. Rendering must degrade gracefully
// instead of throwing "TypeError: e.map is not a function".

test('renders without throwing when questions is a non-array value', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        // Malformed: object instead of an array
        questions: { 0: { question: 'q?', options: [{ label: 'a' }] } } as never,
        answers: {},
      }),
    );
  });
});

test('renders without throwing when a question is missing options[]', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [{ question: 'Pick one?', header: 'H' } as never],
        answers: { 'Pick one?': 'X' },
      }),
    );
  });
});

test('renders without throwing when options[] contains malformed entries', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [{ question: 'Pick one?', options: [null, 'oops', { label: 'A' }] } as never],
        answers: { 'Pick one?': 'A, Custom' },
      }),
    );
  });
});

test('renders without throwing when a questions entry is null/non-object', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [null, 'oops', { question: 'Ok?', options: [{ label: 'A' }] }] as never,
        answers: {},
      }),
    );
  });
});

test('renders without throwing when an answer is a non-string value', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [{ question: 'Pick one?', options: [{ label: 'A' }] }],
        // Malformed: answer is an object instead of the expected string
        answers: { 'Pick one?': { unexpected: true } } as never,
      }),
    );
  });
});

test('still renders a well-formed question + answer', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick one?', header: 'H', options: [{ label: 'A' }, { label: 'B' }] }],
      answers: { 'Pick one?': 'A' },
    }),
  );
  assert.ok(html.includes('Pick one?'));
});

// #518: a pending question (the tool has no result yet — still waiting on the
// user) must NOT read as "Skipped". Rendering "Skipped" while the actionable
// panel was still asking made it look like the conversation had moved on
// without the user choosing anything.
test('a pending single question shows "waiting", not "Skipped"', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick a fruit?', options: [{ label: 'Apple' }, { label: 'Banana' }] }],
      answers: {},
      resolved: false,
    }),
  );
  assert.ok(!html.includes('Skipped'), 'pending question must not render "Skipped"');
  assert.ok(html.includes('Waiting for your answer'), 'pending question should say it is waiting');
});

test('a resolved single question with no answer still shows "Skipped"', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick a fruit?', options: [{ label: 'Apple' }, { label: 'Banana' }] }],
      answers: {},
      resolved: true,
    }),
  );
  assert.ok(html.includes('Skipped'), 'a genuinely skipped (resolved, answerless) question is still Skipped');
  assert.ok(!html.includes('Waiting for your answer'));
});

// Locks the invariant for the per-question branches: even if a pending
// multi-question call ever surfaced a partial answer set, the still-unanswered
// question must not read as "Skipped" while the tool is pending (#518).
test('a pending multi-question set never marks an unanswered question "Skipped"', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [
        { question: 'Q1?', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Q2?', options: [{ label: 'C' }, { label: 'D' }] },
      ],
      answers: { 'Q1?': 'A' }, // Q2 unanswered, but the tool is still pending
      resolved: false,
    }),
  );
  assert.ok(!html.includes('Skipped'), 'a pending multi-question set must not render "Skipped"');
});

test('defaults to resolved so a persisted transcript row is unchanged', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick a fruit?', options: [{ label: 'Apple' }] }],
      answers: {},
      // no `resolved` prop
    }),
  );
  assert.ok(html.includes('Skipped'));
});
