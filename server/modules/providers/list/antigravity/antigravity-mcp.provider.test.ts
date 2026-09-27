import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AntigravityMcpProvider } from './antigravity-mcp.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => { (os as any).homedir = original; };
};

test('AntigravityMcpProvider: upserts, lists, and removes servers across user/project scopes and both transports', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-mcp-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const restore = patchHomeDir(tempRoot);

  try {
    const provider = new AntigravityMcpProvider();

    await provider.upsertServer({
      name: 'agy-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      env: { FOO: 'bar' },
      cwd: '/work',
    });

    await provider.upsertServer({
      name: 'agy-project-http',
      scope: 'project',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      workspacePath,
    });

    const all = await provider.listServers({ workspacePath });
    assert.equal(all.user.length, 1);
    assert.equal(all.user[0].command, 'npx');
    assert.equal(all.user[0].cwd, '/work');
    assert.equal(all.project.length, 1);
    assert.equal(all.project[0].url, 'https://example.com/mcp');
    assert.deepEqual(all.local, []);

    // Config files land where getConfigPath says they should.
    const userConfig = JSON.parse(
      await fs.readFile(path.join(tempRoot, '.gemini', 'config', 'mcp_config.json'), 'utf8'),
    );
    assert.ok(userConfig.mcpServers['agy-user-stdio']);
    const projectConfig = JSON.parse(
      await fs.readFile(path.join(workspacePath, '.agents', 'mcp_config.json'), 'utf8'),
    );
    assert.ok(projectConfig.mcpServers['agy-project-http']);

    const removed = await provider.removeServer({ name: 'agy-user-stdio', scope: 'user' });
    assert.equal(removed.removed, true);
    const afterRemoval = await provider.listServersForScope('user');
    assert.equal(afterRemoval.length, 0);

    const removedAgain = await provider.removeServer({ name: 'agy-user-stdio', scope: 'user' });
    assert.equal(removedAgain.removed, false);
  } finally {
    restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravityMcpProvider: "local" scope is unsupported (only user/project)', async () => {
  const provider = new AntigravityMcpProvider();
  await assert.rejects(
    () => provider.upsertServer({ name: 'x', scope: 'local', transport: 'stdio', command: 'x' }),
    /does not support "local" MCP scope/,
  );
});

test('AntigravityMcpProvider: buildServerConfig requires command for stdio and url for http', async () => {
  const provider = new AntigravityMcpProvider();
  await assert.rejects(
    () => provider.upsertServer({ name: 'x', scope: 'project', transport: 'stdio', command: '  ', workspacePath: os.tmpdir() }),
    /command is required for stdio MCP servers/,
  );
  await assert.rejects(
    () => provider.upsertServer({ name: 'x', scope: 'project', transport: 'http', url: '  ', workspacePath: os.tmpdir() }),
    /url is required for http MCP servers/,
  );
});

test('AntigravityMcpProvider: normalizeServerConfig skips entries with neither a command nor a url', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-mcp-bad-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(path.join(workspacePath, '.agents'), { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, '.agents', 'mcp_config.json'),
    JSON.stringify({ mcpServers: { broken: { nothingUseful: true } } }),
    'utf8',
  );

  try {
    const provider = new AntigravityMcpProvider();
    const servers = await provider.listServersForScope('project', { workspacePath });
    assert.deepEqual(servers, []);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
