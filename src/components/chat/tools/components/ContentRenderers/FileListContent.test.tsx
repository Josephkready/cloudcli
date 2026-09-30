import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FileListContent } from './FileListContent';

test('renders each file\'s basename as plain text with the full path as a tooltip', () => {
  const html = renderToStaticMarkup(
    React.createElement(FileListContent, { files: ['/a/b/one.ts', '/a/two.ts'] }),
  );
  assert.ok(html.includes('>one.ts<'));
  assert.ok(html.includes('>two.ts<'));
  assert.ok(html.includes('title="/a/b/one.ts"'));
  assert.ok(!html.includes('<button'), 'file names are not clickable');
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

test('falls back to the full path when there is no "/" to split on', () => {
  const html = renderToStaticMarkup(
    React.createElement(FileListContent, { files: ['justafile.ts'] }),
  );
  assert.ok(html.includes('justafile.ts'));
});
