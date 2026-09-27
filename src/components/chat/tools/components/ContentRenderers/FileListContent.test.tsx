import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FileListContent } from './FileListContent';

test('renders each file\'s basename as a button and a title tooltip with the full path', () => {
  const html = renderToStaticMarkup(
    React.createElement(FileListContent, { files: ['/a/b/one.ts', '/a/two.ts'] }),
  );
  assert.ok(html.includes('>one.ts<'));
  assert.ok(html.includes('>two.ts<'));
  assert.ok(html.includes('title="/a/b/one.ts"'));
});

test('renders a title heading when provided', () => {
  const html = renderToStaticMarkup(
    React.createElement(FileListContent, { files: ['/a.ts'], title: 'Matched files' }),
  );
  assert.ok(html.includes('Matched files'));
});

test('omits the title heading when not provided', () => {
  const html = renderToStaticMarkup(React.createElement(FileListContent, { files: ['/a.ts'] }));
  assert.ok(!html.includes('Matched files'));
});

test('separates entries with a comma except after the last one', () => {
  const html = renderToStaticMarkup(
    React.createElement(FileListContent, { files: ['/a.ts', '/b.ts'] }),
  );
  const commaCount = (html.match(/>,</g) || []).length;
  assert.equal(commaCount, 1, 'exactly one separator for two files');
});

test('supports FileListItem objects with their own onClick handler', () => {
  const html = renderToStaticMarkup(
    React.createElement(FileListContent, {
      files: [{ path: '/a/custom.ts', onClick: () => {} }],
    }),
  );
  assert.ok(html.includes('custom.ts'));
});

test('falls back to the full path when there is no "/" to split on', () => {
  const html = renderToStaticMarkup(
    React.createElement(FileListContent, { files: ['justafile.ts'] }),
  );
  assert.ok(html.includes('justafile.ts'));
});
