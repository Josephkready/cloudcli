import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import {
  parseChangeActiveModelPayload,
  parseMcpScope,
  parseMcpTransport,
  parseMcpUpsertPayload,
  parseProviderSkillCreatePayload,
  parseSessionRenameSummary,
} from './provider.body.parsers.js';

/** Assert that `fn` throws an `AppError` carrying the given `code` and 400 status. */
function assertRejects(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, 400);
    return true;
  });
}

/* ── parseMcpScope ───────────────────────────────────────────────────────── */

test('parseMcpScope: returns undefined for absent or empty values', () => {
  assert.equal(parseMcpScope(undefined), undefined);
  assert.equal(parseMcpScope(''), undefined);
  assert.equal(parseMcpScope('   '), undefined);
  // A repeated ?param arrives as a non-string array -> reads as absent.
  assert.equal(parseMcpScope(['user', 'local']), undefined);
});

test('parseMcpScope: accepts the three valid scopes (trimmed)', () => {
  assert.equal(parseMcpScope('user'), 'user');
  assert.equal(parseMcpScope('local'), 'local');
  assert.equal(parseMcpScope('  project  '), 'project');
});

test('parseMcpScope: rejects an unsupported scope', () => {
  assertRejects(() => parseMcpScope('global'), 'INVALID_MCP_SCOPE');
});

/* ── parseMcpTransport ───────────────────────────────────────────────────── */

test('parseMcpTransport: accepts the three valid transports (trimmed)', () => {
  assert.equal(parseMcpTransport('stdio'), 'stdio');
  assert.equal(parseMcpTransport('http'), 'http');
  assert.equal(parseMcpTransport('  sse '), 'sse');
});

test('parseMcpTransport: requires a value', () => {
  assertRejects(() => parseMcpTransport(undefined), 'MCP_TRANSPORT_REQUIRED');
  assertRejects(() => parseMcpTransport(''), 'MCP_TRANSPORT_REQUIRED');
  assertRejects(() => parseMcpTransport(['stdio']), 'MCP_TRANSPORT_REQUIRED');
});

test('parseMcpTransport: rejects an unsupported transport', () => {
  assertRejects(() => parseMcpTransport('grpc'), 'INVALID_MCP_TRANSPORT');
});

/* ── parseMcpUpsertPayload ───────────────────────────────────────────────── */

test('parseMcpUpsertPayload: requires an object body, a name, and a transport', () => {
  assertRejects(() => parseMcpUpsertPayload(null), 'INVALID_REQUEST_BODY');
  assertRejects(() => parseMcpUpsertPayload('nope'), 'INVALID_REQUEST_BODY');
  assertRejects(() => parseMcpUpsertPayload({ transport: 'stdio' }), 'MCP_NAME_REQUIRED');
  assertRejects(() => parseMcpUpsertPayload({ name: 'srv' }), 'MCP_TRANSPORT_REQUIRED');
});

test('parseMcpUpsertPayload: returns a minimal normalized shape with undefined optionals', () => {
  const result = parseMcpUpsertPayload({ name: 'srv', transport: 'stdio' });
  assert.equal(result.name, 'srv');
  assert.equal(result.transport, 'stdio');
  assert.equal(result.scope, undefined);
  assert.equal(result.command, undefined);
  assert.equal(result.args, undefined);
  assert.equal(result.env, undefined);
});

test('parseMcpUpsertPayload: filters non-string members out of arrays and maps', () => {
  const result = parseMcpUpsertPayload({
    name: 'srv',
    transport: 'http',
    scope: 'project',
    args: ['--a', 5, '--b', null],
    env: { KEEP: 'yes', DROP: 3 },
    envVars: ['A', 7],
    headers: { 'X-Ok': 'v', 'X-Bad': {} },
    envHttpHeaders: { 'X-Env': 'e', 'X-Drop': 5 },
  });
  assert.equal(result.scope, 'project');
  assert.deepEqual(result.args, ['--a', '--b']);
  assert.deepEqual(result.env, { KEEP: 'yes' });
  assert.deepEqual(result.envVars, ['A']);
  assert.deepEqual(result.headers, { 'X-Ok': 'v' });
  assert.deepEqual(result.envHttpHeaders, { 'X-Env': 'e' });
});

test('parseMcpUpsertPayload: passes through and trims the optional string fields', () => {
  const result = parseMcpUpsertPayload({
    name: 'srv',
    transport: 'stdio',
    command: '  run-me  ',
    cwd: '/work',
    url: 'https://example.test',
    workspacePath: '  /ws  ',
    bearerTokenEnvVar: 'TOKEN_ENV',
  });
  assert.equal(result.command, 'run-me');
  assert.equal(result.cwd, '/work');
  assert.equal(result.url, 'https://example.test');
  assert.equal(result.workspacePath, '/ws');
  assert.equal(result.bearerTokenEnvVar, 'TOKEN_ENV');
});

/* ── parseProviderSkillCreatePayload ─────────────────────────────────────── */

test('parseProviderSkillCreatePayload: accepts the single-entry content shorthand', () => {
  const result = parseProviderSkillCreatePayload({ content: '# Skill', directoryName: 'my-skill' });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].content, '# Skill');
  assert.equal(result.entries[0].directoryName, 'my-skill');
  assert.equal(result.entries[0].files, undefined);
});

test('parseProviderSkillCreatePayload: accepts an explicit entries array', () => {
  const result = parseProviderSkillCreatePayload({
    entries: [{ content: 'a' }, { content: 'b' }],
  });
  assert.deepEqual(result.entries.map((entry) => entry.content), ['a', 'b']);
});

test('parseProviderSkillCreatePayload: requires an object body and at least one entry', () => {
  assertRejects(() => parseProviderSkillCreatePayload(undefined), 'INVALID_REQUEST_BODY');
  assertRejects(() => parseProviderSkillCreatePayload({}), 'PROVIDER_SKILLS_REQUIRED');
  assertRejects(() => parseProviderSkillCreatePayload({ entries: [] }), 'PROVIDER_SKILLS_REQUIRED');
});

test('parseProviderSkillCreatePayload: requires non-empty markdown content per entry', () => {
  assertRejects(
    () => parseProviderSkillCreatePayload({ entries: [{ content: '   ' }] }),
    'PROVIDER_SKILL_CONTENT_REQUIRED',
  );
  assertRejects(
    () => parseProviderSkillCreatePayload({ entries: ['not-an-object'] }),
    'INVALID_REQUEST_BODY',
  );
});

test('parseProviderSkillCreatePayload: validates the shape of any files array', () => {
  assertRejects(
    () => parseProviderSkillCreatePayload({ entries: [{ content: 'a', files: 'nope' }] }),
    'INVALID_REQUEST_BODY',
  );
  // Missing encoding on a file entry is rejected.
  assertRejects(
    () => parseProviderSkillCreatePayload({
      entries: [{ content: 'a', files: [{ relativePath: 'f.txt', content: 'x' }] }],
    }),
    'INVALID_REQUEST_BODY',
  );
  // An unsupported encoding (not utf8/base64) is rejected the same way.
  assertRejects(
    () => parseProviderSkillCreatePayload({
      entries: [{ content: 'a', files: [{ relativePath: 'f.txt', content: 'x', encoding: 'ascii' }] }],
    }),
    'INVALID_REQUEST_BODY',
  );
  // A fully-specified file passes through with its encoding preserved.
  const ok = parseProviderSkillCreatePayload({
    entries: [{ content: 'a', files: [{ relativePath: 'f.bin', content: 'AA==', encoding: 'base64' }] }],
  });
  assert.deepEqual(ok.entries[0].files, [
    { relativePath: 'f.bin', content: 'AA==', encoding: 'base64' },
  ]);
});

/* ── parseSessionRenameSummary ───────────────────────────────────────────── */

test('parseSessionRenameSummary: trims and returns a non-empty summary', () => {
  assert.equal(parseSessionRenameSummary({ summary: '  New title  ' }), 'New title');
});

test('parseSessionRenameSummary: enforces the 500-character upper bound', () => {
  const maxLen = 'a'.repeat(500);
  assert.equal(parseSessionRenameSummary({ summary: maxLen }), maxLen); // boundary: 500 is allowed
  assertRejects(
    () => parseSessionRenameSummary({ summary: 'a'.repeat(501) }),
    'INVALID_SESSION_SUMMARY',
  );
});

test('parseSessionRenameSummary: requires an object body with a non-empty summary', () => {
  assertRejects(() => parseSessionRenameSummary(null), 'INVALID_REQUEST_BODY');
  assertRejects(() => parseSessionRenameSummary({}), 'INVALID_SESSION_SUMMARY');
  assertRejects(() => parseSessionRenameSummary({ summary: '   ' }), 'INVALID_SESSION_SUMMARY');
  assertRejects(() => parseSessionRenameSummary({ summary: 42 }), 'INVALID_SESSION_SUMMARY');
});

/* ── parseChangeActiveModelPayload ───────────────────────────────────────── */

test('parseChangeActiveModelPayload: returns the model with an empty placeholder sessionId', () => {
  const result = parseChangeActiveModelPayload({ model: 'opus' });
  assert.equal(result.model, 'opus');
  // The route fills sessionId in from the path param; the parser leaves it blank.
  assert.equal(result.sessionId, '');
});

test('parseChangeActiveModelPayload: requires an object body with a model', () => {
  assertRejects(() => parseChangeActiveModelPayload(undefined), 'INVALID_REQUEST_BODY');
  assertRejects(() => parseChangeActiveModelPayload({}), 'MODEL_REQUIRED');
  assertRejects(() => parseChangeActiveModelPayload({ model: '   ' }), 'MODEL_REQUIRED');
});
