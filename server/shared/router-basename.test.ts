import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRouterBasenameScript,
  getRouterBasename,
  injectRouterBasenameIntoHtml,
} from '@/shared/router-basename.js';

test('getRouterBasename returns empty string when the env var is unset', () => {
  assert.equal(getRouterBasename({}), '');
});

test('getRouterBasename returns empty string when the env var is explicitly empty', () => {
  assert.equal(getRouterBasename({ ROUTER_BASENAME: '' }), '');
});

test('getRouterBasename returns the configured value when set', () => {
  assert.equal(
    getRouterBasename({ ROUTER_BASENAME: '/claudecodeui' }),
    '/claudecodeui',
  );
});

test('buildRouterBasenameScript JSON-encodes the basename value', () => {
  assert.equal(
    buildRouterBasenameScript('/claudecodeui'),
    '<script>window.__ROUTER_BASENAME__="/claudecodeui";</script>',
  );
});

test('buildRouterBasenameScript escapes embedded </script> sequences so they cannot close the tag early', () => {
  const script = buildRouterBasenameScript('</script><script>alert(1)</script>');
  // The dangerous "<" must be escaped so the browser cannot terminate the
  // surrounding <script> block (via "</script>") nor open a fresh injected
  // one (via "<script>") through the value of __ROUTER_BASENAME__.
  assert.ok(!script.includes('</script><script>alert'));
  // Confirm the literal value substring has its "<" characters escaped to
  // their JSON unicode form, which is safe inline inside a <script> body.
  assert.ok(script.includes('\\u003c/script>'));
  assert.ok(script.includes('\\u003cscript>alert(1)'));
});

test('buildRouterBasenameScript handles the empty-string default exactly like the historical fallback', () => {
  assert.equal(
    buildRouterBasenameScript(''),
    '<script>window.__ROUTER_BASENAME__="";</script>',
  );
});

test('injectRouterBasenameIntoHtml inserts the script immediately after <head>', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body></body></html>';
  const out = injectRouterBasenameIntoHtml(html, '/claudecodeui');
  assert.equal(
    out,
    '<!doctype html><html><head><script>window.__ROUTER_BASENAME__="/claudecodeui";</script><title>x</title></head><body></body></html>',
  );
});

test('injectRouterBasenameIntoHtml works when <head> has attributes', () => {
  const html = '<html><head data-foo="bar"><title>x</title></head></html>';
  const out = injectRouterBasenameIntoHtml(html, '/p');
  assert.equal(
    out,
    '<html><head data-foo="bar"><script>window.__ROUTER_BASENAME__="/p";</script><title>x</title></head></html>',
  );
});

test('injectRouterBasenameIntoHtml matches <HEAD> case-insensitively', () => {
  const html = '<HTML><HEAD><TITLE>x</TITLE></HEAD></HTML>';
  const out = injectRouterBasenameIntoHtml(html, '/p');
  assert.ok(out.startsWith('<HTML><HEAD><script>window.__ROUTER_BASENAME__="/p";</script>'));
});

test('injectRouterBasenameIntoHtml leaves HTML without a <head> tag untouched', () => {
  const html = '<div>no head here</div>';
  assert.equal(injectRouterBasenameIntoHtml(html, '/p'), html);
});

test('injectRouterBasenameIntoHtml injects an empty-string assignment by default', () => {
  // Critical backwards-compat: when ROUTER_BASENAME is unset we still emit
  // window.__ROUTER_BASENAME__ = "" so the `||  ""` fallback in App.tsx keeps
  // behaving exactly as it did before this middleware existed.
  const html = '<html><head><title>x</title></head></html>';
  const out = injectRouterBasenameIntoHtml(html, '');
  assert.ok(out.includes('<script>window.__ROUTER_BASENAME__="";</script>'));
});

test('injectRouterBasenameIntoHtml only injects once per response', () => {
  // The regex is not /g, so we should never insert more than a single tag
  // even if the HTML somehow contains a duplicate <head>.
  const html = '<head></head><head></head>';
  const out = injectRouterBasenameIntoHtml(html, '/p');
  const matches = out.match(/__ROUTER_BASENAME__/g) ?? [];
  assert.equal(matches.length, 1);
});
