import assert from 'node:assert/strict';
import test from 'node:test';

// This file lives directly under server/ (rather than mirroring shared/) so
// it is picked up by the `test:server` glob ("server/**/*.test.js") --
// `shared/networkHosts.js` sits at the repo root, outside every existing test
// glob, but is imported by server/index.js the same way.
import { normalizeLoopbackHost, getConnectableHost } from '../shared/networkHosts.js';

test('normalizeLoopbackHost maps loopback aliases to "localhost" and passes through other hosts', () => {
  assert.equal(normalizeLoopbackHost('localhost'), 'localhost');
  assert.equal(normalizeLoopbackHost('127.0.0.1'), 'localhost');
  assert.equal(normalizeLoopbackHost('::1'), 'localhost');
  assert.equal(normalizeLoopbackHost('[::1]'), 'localhost');
  assert.equal(normalizeLoopbackHost('example.com'), 'example.com');
});

test('normalizeLoopbackHost passes through falsy input unchanged', () => {
  assert.equal(normalizeLoopbackHost(''), '');
  assert.equal(normalizeLoopbackHost(null), null);
  assert.equal(normalizeLoopbackHost(undefined), undefined);
});

test('getConnectableHost maps wildcard and loopback hosts to "localhost"', () => {
  assert.equal(getConnectableHost('0.0.0.0'), 'localhost');
  assert.equal(getConnectableHost('::'), 'localhost');
  assert.equal(getConnectableHost('localhost'), 'localhost');
  assert.equal(getConnectableHost('127.0.0.1'), 'localhost');
  assert.equal(getConnectableHost('::1'), 'localhost');
  assert.equal(getConnectableHost('[::1]'), 'localhost');
});

test('getConnectableHost passes through a real hostname and defaults falsy input', () => {
  assert.equal(getConnectableHost('example.com'), 'example.com');
  assert.equal(getConnectableHost(''), 'localhost');
  assert.equal(getConnectableHost(null), 'localhost');
  assert.equal(getConnectableHost(undefined), 'localhost');
});
