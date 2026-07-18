import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MCP_FORM } from '../constants';
import type { McpFormState } from '../types';

import {
  createMcpPayloadFromForm,
  formatKeyValueLines,
  getErrorMessage,
  getProjectPath,
  isMcpScope,
  isMcpTransport,
  maskSecret,
  parseJsonMcpPayload,
  parseKeyValueLines,
  parseListLines,
} from './mcpFormatting';

/* ── maskSecret ──────────────────────────────────────────────────────────── */

test('maskSecret: fully masks values of four characters or fewer', () => {
  assert.equal(maskSecret(''), '****');
  assert.equal(maskSecret('abcd'), '****');
  assert.equal(maskSecret(null), '****');
  assert.equal(maskSecret(undefined), '****');
});

test('maskSecret: reveals the first and last two characters of longer values', () => {
  assert.equal(maskSecret('abcde'), 'ab****de');
  assert.equal(maskSecret('secret-value'), 'se****ue');
  assert.equal(maskSecret(12345), '12****45');
});

/* ── parseKeyValueLines / formatKeyValueLines ────────────────────────────── */

test('parseKeyValueLines: splits KEY=VALUE lines and trims surrounding whitespace', () => {
  assert.deepEqual(parseKeyValueLines('A=1\nB=2'), { A: '1', B: '2' });
  assert.deepEqual(parseKeyValueLines('  KEY  =  val  '), { KEY: 'val' });
});

test('parseKeyValueLines: only the first = splits; later ones stay in the value', () => {
  assert.deepEqual(parseKeyValueLines('URL=http://x?a=b'), { URL: 'http://x?a=b' });
});

test('parseKeyValueLines: a keyless/blank line is skipped; a value-less key maps to empty', () => {
  assert.deepEqual(parseKeyValueLines(''), {});
  assert.deepEqual(parseKeyValueLines('A=1\n\nNOVALUE'), { A: '1', NOVALUE: '' });
});

test('formatKeyValueLines: renders KEY=VALUE lines and round-trips through the parser', () => {
  const map = { A: '1', B: '2' };
  assert.equal(formatKeyValueLines(map), 'A=1\nB=2');
  assert.deepEqual(parseKeyValueLines(formatKeyValueLines(map)), map);
});

/* ── parseListLines ──────────────────────────────────────────────────────── */

test('parseListLines: trims entries and drops blank lines', () => {
  assert.deepEqual(parseListLines('a\n b \n\nc'), ['a', 'b', 'c']);
  assert.deepEqual(parseListLines(''), []);
});

/* ── type guards + small helpers ─────────────────────────────────────────── */

test('isMcpScope: accepts the three known scopes only', () => {
  assert.equal(isMcpScope('user'), true);
  assert.equal(isMcpScope('local'), true);
  assert.equal(isMcpScope('project'), true);
  assert.equal(isMcpScope('global'), false);
  assert.equal(isMcpScope(42), false);
});

test('isMcpTransport: accepts stdio/http/sse only', () => {
  assert.equal(isMcpTransport('stdio'), true);
  assert.equal(isMcpTransport('http'), true);
  assert.equal(isMcpTransport('sse'), true);
  assert.equal(isMcpTransport('ws'), false);
  assert.equal(isMcpTransport(undefined), false);
});

test('getProjectPath: prefers fullPath, then path, then empty string', () => {
  assert.equal(getProjectPath({ fullPath: '/a', path: '/b' }), '/a');
  assert.equal(getProjectPath({ path: '/b' }), '/b');
  assert.equal(getProjectPath({ fullPath: '', path: '/b' }), '/b');
  assert.equal(getProjectPath({}), '');
});

test('getErrorMessage: unwraps Error instances and falls back otherwise', () => {
  assert.equal(getErrorMessage(new Error('boom')), 'boom');
  assert.equal(getErrorMessage('nope'), 'Unknown error');
  assert.equal(getErrorMessage(null), 'Unknown error');
});

/* ── parseJsonMcpPayload ─────────────────────────────────────────────────── */

const form = (jsonInput: string, overrides: Partial<McpFormState> = {}): McpFormState => ({
  ...DEFAULT_MCP_FORM,
  importMode: 'json',
  jsonInput,
  ...overrides,
});

test('parseJsonMcpPayload: builds a normalized stdio payload and trims the name', () => {
  const payload = parseJsonMcpPayload(
    'claude',
    form(JSON.stringify({ type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'x' } }), {
      name: '  my-server  ',
      scope: 'user',
    }),
  );

  assert.equal(payload.name, 'my-server');
  assert.equal(payload.transport, 'stdio');
  assert.equal(payload.command, 'node');
  assert.deepEqual(payload.args, ['server.js']);
  assert.deepEqual(payload.env, { TOKEN: 'x' });
  // scope 'user' drops the workspace path; claude does not support a working dir.
  assert.equal(payload.workspacePath, undefined);
  assert.equal(payload.cwd, undefined);
});

test('parseJsonMcpPayload: codex keeps cwd and provider-specific snake_case fields', () => {
  const payload = parseJsonMcpPayload(
    'codex',
    form(
      JSON.stringify({ type: 'stdio', command: 'run', cwd: '/work', env_vars: ['A'], bearer_token_env_var: 'TOK' }),
    ),
  );

  assert.equal(payload.cwd, '/work');
  assert.deepEqual(payload.envVars, ['A']);
  assert.equal(payload.bearerTokenEnvVar, 'TOK');
});

test('parseJsonMcpPayload: rejects malformed or incomplete configurations', () => {
  assert.throws(() => parseJsonMcpPayload('claude', form('{ not json')), /./);
  assert.throws(
    () => parseJsonMcpPayload('claude', form('42')),
    /JSON configuration must be an object/,
  );
  assert.throws(
    () => parseJsonMcpPayload('claude', form('{}')),
    /Missing required field: type/,
  );
  assert.throws(
    () => parseJsonMcpPayload('claude', form(JSON.stringify({ type: 'stdio' }))),
    /stdio type requires a command field/,
  );
  assert.throws(
    () => parseJsonMcpPayload('claude', form(JSON.stringify({ type: 'http' }))),
    /http type requires a url field/,
  );
});

test('parseJsonMcpPayload: rejects a transport the provider does not support', () => {
  // codex supports stdio/http but not sse.
  assert.throws(
    () => parseJsonMcpPayload('codex', form(JSON.stringify({ type: 'sse', url: 'https://x' }))),
    /codex does not support sse MCP servers/,
  );
});

/* ── createMcpPayloadFromForm ────────────────────────────────────────────── */

test('createMcpPayloadFromForm: stdio form keeps trimmed command/args and drops url/headers', () => {
  const payload = createMcpPayloadFromForm('claude', {
    ...DEFAULT_MCP_FORM,
    importMode: 'form',
    transport: 'stdio',
    name: '  srv  ',
    scope: 'user',
    command: '  node server.js  ',
    args: ['--flag'],
    env: { X: '1' },
    url: 'ignored',
    headers: { H: 'ignored' },
  });

  assert.equal(payload.name, 'srv');
  assert.equal(payload.transport, 'stdio');
  assert.equal(payload.command, 'node server.js');
  assert.deepEqual(payload.args, ['--flag']);
  assert.deepEqual(payload.env, { X: '1' });
  // stdio has no url/headers; scope 'user' drops workspacePath; claude has no cwd.
  assert.equal(payload.url, undefined);
  assert.equal(payload.headers, undefined);
  assert.equal(payload.workspacePath, undefined);
  assert.equal(payload.cwd, undefined);
});

test('createMcpPayloadFromForm: http form keeps trimmed url/headers and drops command/args', () => {
  const payload = createMcpPayloadFromForm('claude', {
    ...DEFAULT_MCP_FORM,
    importMode: 'form',
    transport: 'http',
    scope: 'project',
    workspacePath: '/w',
    command: 'ignored',
    args: ['ignored'],
    url: '  https://example.com  ',
    headers: { Authorization: 'Bearer x' },
  });

  assert.equal(payload.transport, 'http');
  assert.equal(payload.command, undefined);
  assert.equal(payload.args, undefined);
  assert.equal(payload.url, 'https://example.com');
  assert.deepEqual(payload.headers, { Authorization: 'Bearer x' });
  // Non-user scope keeps the workspace path.
  assert.equal(payload.workspacePath, '/w');
});

test('createMcpPayloadFromForm: codex keeps cwd and provider-specific fields (trimmed)', () => {
  const payload = createMcpPayloadFromForm('codex', {
    ...DEFAULT_MCP_FORM,
    importMode: 'form',
    transport: 'stdio',
    command: 'run',
    cwd: '  /work  ',
    envVars: ['A'],
    bearerTokenEnvVar: '  TOK  ',
    envHttpHeaders: { H: '1' },
  });

  assert.equal(payload.cwd, '/work');
  assert.deepEqual(payload.envVars, ['A']);
  assert.equal(payload.bearerTokenEnvVar, 'TOK');
  assert.deepEqual(payload.envHttpHeaders, { H: '1' });
});

test('createMcpPayloadFromForm: json import mode routes through parseJsonMcpPayload', () => {
  const formData: McpFormState = {
    ...DEFAULT_MCP_FORM,
    importMode: 'json',
    jsonInput: JSON.stringify({ type: 'stdio', command: 'node' }),
    name: 'from-json',
  };
  assert.deepEqual(createMcpPayloadFromForm('claude', formData), parseJsonMcpPayload('claude', formData));
});

test('createMcpPayloadFromForm: rejects a transport the provider does not support', () => {
  assert.throws(
    () =>
      createMcpPayloadFromForm('codex', {
        ...DEFAULT_MCP_FORM,
        importMode: 'form',
        transport: 'sse',
      }),
    /codex does not support sse MCP servers/,
  );
});
