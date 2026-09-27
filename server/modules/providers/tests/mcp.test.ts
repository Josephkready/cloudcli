import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import TOML from '@iarna/toml';

import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { AppError } from '@/shared/utils.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const readJson = async (filePath: string): Promise<Record<string, unknown>> => {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
};

/**
 * This test covers Claude MCP support for all scopes (user/local/project) and all transports
 * (stdio/http/sse), including list and remove — the routes still exposed by the API. Servers
 * are seeded directly through the provider's `mcp.upsertServer` (there is no longer an add/update
 * route or service method; the write path only remains as plumbing for `removeServer`'s own
 * read-modify-write cycle and is exercised here to set up fixtures).
 */
test('providerMcpService handles claude MCP scopes/transports with file-backed persistence', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-claude-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const claude = providerRegistry.resolveProvider('claude');

    await claude.mcp.upsertServer({
      name: 'claude-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'my-server'],
      env: { API_KEY: 'secret' },
    });

    await claude.mcp.upsertServer({
      name: 'claude-local-http',
      scope: 'local',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      workspacePath,
    });

    await claude.mcp.upsertServer({
      name: 'claude-project-sse',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.com/sse',
      headers: { 'X-API-Key': 'abc' },
      workspacePath,
    });

    const grouped = await providerMcpService.listProviderMcpServers('claude', { workspacePath });
    assert.ok(grouped.user.some((server) => server.name === 'claude-user-stdio' && server.transport === 'stdio'));
    assert.ok(grouped.local.some((server) => server.name === 'claude-local-http' && server.transport === 'http'));
    assert.ok(grouped.project.some((server) => server.name === 'claude-project-sse' && server.transport === 'sse'));

    // update behavior is the same upsert route with same name
    await claude.mcp.upsertServer({
      name: 'claude-project-sse',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.com/sse-updated',
      headers: { 'X-API-Key': 'updated' },
      workspacePath,
    });

    const projectConfig = await readJson(path.join(workspacePath, '.mcp.json'));
    const projectServers = projectConfig.mcpServers as Record<string, unknown>;
    const projectServer = projectServers['claude-project-sse'] as Record<string, unknown>;
    assert.equal(projectServer.url, 'https://example.com/sse-updated');

    const removeResult = await providerMcpService.removeProviderMcpServer('claude', {
      name: 'claude-local-http',
      scope: 'local',
      workspacePath,
    });
    assert.equal(removeResult.removed, true);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers Codex MCP capability validation (unsupported scope/transport combinations),
 * which still lives on the provider's `mcp.upsertServer` even though the write route/service
 * wrapper around it was removed along with the MCP add form.
 */
test('providerMcpService codex provider rejects unsupported scope/transport combinations', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-codex-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const codex = providerRegistry.resolveProvider('codex');

    await codex.mcp.upsertServer({
      name: 'codex-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'python',
      args: ['server.py'],
      env: { API_KEY: 'x' },
      envVars: ['API_KEY'],
      cwd: '/tmp',
    });

    const userTomlPath = path.join(tempRoot, '.codex', 'config.toml');
    const userConfig = TOML.parse(await fs.readFile(userTomlPath, 'utf8')) as Record<string, unknown>;
    const userServers = userConfig.mcp_servers as Record<string, unknown>;
    const userStdio = userServers['codex-user-stdio'] as Record<string, unknown>;
    assert.equal(userStdio.command, 'python');

    await assert.rejects(
      codex.mcp.upsertServer({
        name: 'codex-local',
        scope: 'local',
        transport: 'stdio',
        command: 'node',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_SCOPE_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );

    await assert.rejects(
      codex.mcp.upsertServer({
        name: 'codex-sse',
        scope: 'project',
        transport: 'sse',
        url: 'https://example.com/sse',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_TRANSPORT_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
