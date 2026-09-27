import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import TOML from '@iarna/toml';

import { CodexMcpProvider } from './codex-mcp.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => { (os as any).homedir = original; };
};

test('CodexMcpProvider: upserts, lists, and removes servers across user/project scopes, persisted as TOML', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mcp-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const restore = patchHomeDir(tempRoot);

  try {
    const provider = new CodexMcpProvider();

    await provider.upsertServer({
      name: 'codex-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      env: { FOO: 'bar' },
      envVars: ['SOME_VAR'],
      cwd: '/work',
    });

    await provider.upsertServer({
      name: 'codex-project-http',
      scope: 'project',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      bearerTokenEnvVar: 'MY_TOKEN',
      envHttpHeaders: { 'X-Trace': 'TRACE_VAR' },
      workspacePath,
    });

    const all = await provider.listServers({ workspacePath });
    assert.equal(all.user.length, 1);
    assert.equal(all.user[0].command, 'npx');
    assert.equal(all.user[0].cwd, '/work');
    assert.deepEqual(all.user[0].envVars, ['SOME_VAR']);
    assert.equal(all.project.length, 1);
    assert.equal(all.project[0].url, 'https://example.com/mcp');
    assert.equal(all.project[0].bearerTokenEnvVar, 'MY_TOKEN');

    const userToml = TOML.parse(await fs.readFile(path.join(tempRoot, '.codex', 'config.toml'), 'utf8')) as any;
    assert.ok(userToml.mcp_servers['codex-user-stdio']);
    const projectToml = TOML.parse(
      await fs.readFile(path.join(workspacePath, '.codex', 'config.toml'), 'utf8'),
    ) as any;
    assert.ok(projectToml.mcp_servers['codex-project-http']);

    const removed = await provider.removeServer({ name: 'codex-user-stdio', scope: 'user' });
    assert.equal(removed.removed, true);
    assert.equal((await provider.listServersForScope('user')).length, 0);

    const removedAgain = await provider.removeServer({ name: 'codex-user-stdio', scope: 'user' });
    assert.equal(removedAgain.removed, false);
  } finally {
    restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('CodexMcpProvider: "local" scope is unsupported (only user/project)', async () => {
  const provider = new CodexMcpProvider();
  await assert.rejects(
    () => provider.upsertServer({ name: 'x', scope: 'local', transport: 'stdio', command: 'x' }),
    /does not support "local" MCP scope/,
  );
});

test('CodexMcpProvider: buildServerConfig requires command for stdio and url for http', async () => {
  const provider = new CodexMcpProvider();
  await assert.rejects(
    () => provider.upsertServer({ name: 'x', scope: 'project', transport: 'stdio', command: '  ', workspacePath: os.tmpdir() }),
    /command is required for stdio MCP servers/,
  );
  await assert.rejects(
    () => provider.upsertServer({ name: 'x', scope: 'project', transport: 'http', url: '  ', workspacePath: os.tmpdir() }),
    /url is required for http MCP servers/,
  );
});

test('CodexMcpProvider: a missing config.toml reads as empty rather than throwing (ENOENT is swallowed)', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mcp-missing-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  try {
    const provider = new CodexMcpProvider();
    const servers = await provider.listServersForScope('project', { workspacePath });
    assert.deepEqual(servers, []);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('CodexMcpProvider: normalizeServerConfig skips a raw entry with neither command nor url', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mcp-bad-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(path.join(workspacePath, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, '.codex', 'config.toml'),
    TOML.stringify({ mcp_servers: { broken: { nothing_useful: true } } } as never),
    'utf8',
  );

  try {
    const provider = new CodexMcpProvider();
    const servers = await provider.listServersForScope('project', { workspacePath });
    assert.deepEqual(servers, []);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
