import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { providerModelsService } from '../../modules/providers/services/provider-models.service.js';

const FAKE_CATALOG = {
  models: {
    OPTIONS: [{ value: 'default', label: 'Default', description: 'the default model' }],
    DEFAULT: 'default',
  },
  cache: { updatedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-04T00:00:00.000Z', source: 'fresh' },
};

/** Boot commands.js behind a bare express app, with a temp HOME for user commands. */
async function withCommandsServer(fn) {
  const originalHome = process.env.HOME;
  const originalGetProviderModels = providerModelsService.getProviderModels;
  const originalGetCurrentActiveModel = providerModelsService.getCurrentActiveModel;

  const homeDir = await mkdtemp(path.join(tmpdir(), 'commands-home-'));
  process.env.HOME = homeDir;
  providerModelsService.getProviderModels = async () => FAKE_CATALOG;
  providerModelsService.getCurrentActiveModel = async () => ({ model: 'default' });

  const { default: commandsRouter } = await import('../commands.js');
  const app = express();
  app.use(express.json());
  app.use('/api/commands', commandsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/commands`;

  try {
    await fn({ baseUrl, homeDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    process.env.HOME = originalHome;
    providerModelsService.getProviderModels = originalGetProviderModels;
    providerModelsService.getCurrentActiveModel = originalGetCurrentActiveModel;
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function post(baseUrl, urlPath, body) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// ---------------------------------------------------------------------------
// POST /list
// ---------------------------------------------------------------------------

test('POST /list returns builtin commands and scans user + project directories', async () => {
  await withCommandsServer(async ({ baseUrl, homeDir }) => {
    const userCommandsDir = path.join(homeDir, '.claude', 'commands');
    await mkdir(userCommandsDir, { recursive: true });
    await writeFile(
      path.join(userCommandsDir, 'greet.md'),
      '---\ndescription: Say hello\n---\nHello there\n',
    );
    await mkdir(path.join(userCommandsDir, 'nested'), { recursive: true });
    await writeFile(path.join(userCommandsDir, 'nested', 'deep.md'), '# Deep command\nBody text');

    const tempProject = await mkdtemp(path.join(tmpdir(), 'commands-project-'));
    const projectCommandsDir = path.join(tempProject, '.claude', 'commands');
    await mkdir(projectCommandsDir, { recursive: true });
    await writeFile(path.join(projectCommandsDir, 'build.md'), '---\ndescription: Build it\n---\nBuild');

    try {
      const { status, body } = await post(baseUrl, '/list', { projectPath: tempProject });
      assert.equal(status, 200);
      assert.equal(body.builtIn.length, 6);

      const names = body.custom.map((c) => c.name);
      assert.ok(names.includes('/greet'));
      assert.ok(names.includes('/nested/deep'));
      assert.ok(names.includes('/build'));

      const greet = body.custom.find((c) => c.name === '/greet');
      assert.equal(greet.description, 'Say hello');
      assert.equal(greet.namespace, 'user');

      const deep = body.custom.find((c) => c.name === '/nested/deep');
      assert.equal(deep.description, 'Deep command');

      const build = body.custom.find((c) => c.name === '/build');
      assert.equal(build.namespace, 'project');

      // custom commands sorted alphabetically
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      assert.deepEqual(names, sorted);

      assert.equal(body.count, body.builtIn.length + body.custom.length);
    } finally {
      await rm(tempProject, { recursive: true, force: true });
    }
  });
});

test('POST /list works with no projectPath and no user commands directory', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const { status, body } = await post(baseUrl, '/list', {});
    assert.equal(status, 200);
    assert.equal(body.custom.length, 0);
    assert.equal(body.count, body.builtIn.length);
  });
});

// ---------------------------------------------------------------------------
// POST /execute -- builtin commands
// ---------------------------------------------------------------------------

test('POST /execute /help returns markdown content and the command list', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const { status, body } = await post(baseUrl, '/execute', { commandName: '/help' });
    assert.equal(status, 200);
    assert.equal(body.type, 'builtin');
    assert.equal(body.action, 'help');
    assert.equal(body.data.format, 'markdown');
    assert.match(body.data.content, /Claude Code Commands/);
    assert.ok(body.data.commands.some((c) => c.name === '/status'));
  });
});

test('POST /execute /models delegates to executeModelsCommand', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const { status, body } = await post(baseUrl, '/execute', {
      commandName: '/models',
      context: { provider: 'claude' },
    });
    assert.equal(status, 200);
    assert.equal(body.action, 'models');
    assert.equal(body.data.current.provider, 'claude');
  });
});

test('POST /execute /cost computes usage from a raw token breakdown', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const { status, body } = await post(baseUrl, '/execute', {
      commandName: '/cost',
      context: {
        provider: 'claude',
        tokenUsage: { inputTokens: 100, outputTokens: 50, total: 1000 },
      },
    });
    assert.equal(status, 200);
    assert.equal(body.action, 'cost');
    assert.equal(body.data.tokenUsage.used, 150);
    assert.equal(body.data.tokenUsage.total, 1000);
    assert.deepEqual(body.data.tokenBreakdown, { input: 100, output: 50 });
  });
});

test('POST /execute /cost falls back to reported "used" when no breakdown is present', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const { status, body } = await post(baseUrl, '/execute', {
      commandName: '/cost',
      context: { tokenUsage: { used: 42, total: 500 } },
    });
    assert.equal(status, 200);
    assert.equal(body.data.tokenUsage.used, 42);
    assert.equal(body.data.tokenBreakdown, undefined);
  });
});

test('POST /execute /status reports version, model, and provider', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const { status, body } = await post(baseUrl, '/execute', {
      commandName: '/status',
      context: { provider: 'claude' },
    });
    assert.equal(status, 200);
    assert.equal(body.action, 'status');
    assert.equal(typeof body.data.version, 'string');
    assert.equal(body.data.provider, 'claude');
    assert.equal(body.data.model, 'default');
    assert.equal(typeof body.data.uptimeSeconds, 'number');
    assert.equal(typeof body.data.memoryUsage.rssMb, 'number');
  });
});

test('POST /execute /memory reports "no project selected" when projectPath is missing', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const { status, body } = await post(baseUrl, '/execute', { commandName: '/memory', context: {} });
    assert.equal(status, 200);
    assert.equal(body.data.error, 'No project selected');
  });
});

test('POST /execute /memory reports whether CLAUDE.md exists for the given project', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const tempProject = await mkdtemp(path.join(tmpdir(), 'commands-memory-'));
    try {
      const missing = await post(baseUrl, '/execute', {
        commandName: '/memory',
        context: { projectPath: tempProject },
      });
      assert.equal(missing.body.data.exists, false);
      assert.match(missing.body.data.message, /not found/);

      await writeFile(path.join(tempProject, 'CLAUDE.md'), '# notes');
      const present = await post(baseUrl, '/execute', {
        commandName: '/memory',
        context: { projectPath: tempProject },
      });
      assert.equal(present.body.data.exists, true);
      assert.match(present.body.data.message, /Opening CLAUDE.md/);
    } finally {
      await rm(tempProject, { recursive: true, force: true });
    }
  });
});

test('POST /execute /config returns a static message', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const { status, body } = await post(baseUrl, '/execute', { commandName: '/config' });
    assert.equal(status, 200);
    assert.equal(body.data.message, 'Opening settings...');
  });
});

test('POST /execute requires a commandName', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const { status, body } = await post(baseUrl, '/execute', {});
    assert.equal(status, 400);
    assert.match(body.error, /Command name is required/);
  });
});

// ---------------------------------------------------------------------------
// POST /execute -- custom commands
// ---------------------------------------------------------------------------

test('POST /execute runs a custom user command with argument substitution', async () => {
  await withCommandsServer(async ({ baseUrl, homeDir }) => {
    const userCommandsDir = path.join(homeDir, '.claude', 'commands');
    await mkdir(userCommandsDir, { recursive: true });
    const commandPath = path.join(userCommandsDir, 'greet.md');
    await writeFile(
      commandPath,
      '---\ndescription: greet\n---\nHello $1, you said: $ARGUMENTS\n',
    );

    const { status, body } = await post(baseUrl, '/execute', {
      commandName: '/greet',
      commandPath,
      args: ['world', 'hi'],
    });
    assert.equal(status, 200);
    assert.equal(body.type, 'custom');
    assert.equal(body.content, 'Hello world, you said: world hi\n');
    assert.equal(body.metadata.description, 'greet');
  });
});

test('POST /execute rejects a custom command path outside the allowed directories', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'commands-outside-'));
    const commandPath = path.join(outside, 'evil.md');
    await writeFile(commandPath, 'rm -rf /');
    try {
      const { status, body } = await post(baseUrl, '/execute', {
        commandName: '/evil',
        commandPath,
        args: [],
      });
      assert.equal(status, 403);
      assert.match(body.error, /Access denied/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('POST /execute requires a commandPath for unknown (custom) commands', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const { status, body } = await post(baseUrl, '/execute', { commandName: '/whatever' });
    assert.equal(status, 400);
    assert.match(body.error, /Command path is required/);
  });
});

test('POST /execute returns 404 for a missing custom command file', async () => {
  await withCommandsServer(async ({ baseUrl, homeDir }) => {
    const userCommandsDir = path.join(homeDir, '.claude', 'commands');
    await mkdir(userCommandsDir, { recursive: true });
    const commandPath = path.join(userCommandsDir, 'missing.md');

    const { status, body } = await post(baseUrl, '/execute', {
      commandName: '/missing',
      commandPath,
      args: [],
    });
    assert.equal(status, 404);
    assert.match(body.error, /Command not found/);
  });
});

test('POST /execute allows a project-scoped custom command path', async () => {
  await withCommandsServer(async ({ baseUrl }) => {
    const tempProject = await mkdtemp(path.join(tmpdir(), 'commands-projexec-'));
    const projectCommandsDir = path.join(tempProject, '.claude', 'commands');
    await mkdir(projectCommandsDir, { recursive: true });
    const commandPath = path.join(projectCommandsDir, 'build.md');
    await writeFile(commandPath, 'Building @file.txt with !ls');

    try {
      const { status, body } = await post(baseUrl, '/execute', {
        commandName: '/build',
        commandPath,
        context: { projectPath: tempProject },
        args: [],
      });
      assert.equal(status, 200);
      assert.equal(body.hasFileIncludes, true);
      assert.equal(body.hasBashCommands, true);
    } finally {
      await rm(tempProject, { recursive: true, force: true });
    }
  });
});
