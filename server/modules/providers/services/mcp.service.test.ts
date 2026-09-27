import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerMcpService } from './mcp.service.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => { (os as any).homedir = original; };
};

test('providerMcpService: lists, scopes, and removes a server through the real provider registry', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-service-'));
  const restore = patchHomeDir(tempRoot);

  try {
    await providerMcpService.listProviderMcpServers('claude').then(async (before) => {
      assert.deepEqual(before.user, []);
    });

    const workspacePath = path.join(tempRoot, 'workspace');
    await fs.mkdir(workspacePath, { recursive: true });

    // Seed a user-scope server directly through the registry-resolved provider
    // (mirrors how the real routes call it — providerMcpService never writes
    // configs itself, it only delegates).
    const { providerRegistry } = await import('@/modules/providers/provider.registry.js');
    await providerRegistry.resolveProvider('claude').mcp.upsertServer({
      name: 'svc-test-server',
      scope: 'user',
      transport: 'stdio',
      command: 'npx',
    });

    const all = await providerMcpService.listProviderMcpServers('claude');
    assert.equal(all.user.length, 1);

    const scoped = await providerMcpService.listProviderMcpServersForScope('claude', 'user');
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].name, 'svc-test-server');

    const removed = await providerMcpService.removeProviderMcpServer('claude', { name: 'svc-test-server', scope: 'user' });
    assert.equal(removed.removed, true);

    const afterRemoval = await providerMcpService.listProviderMcpServersForScope('claude', 'user');
    assert.equal(afterRemoval.length, 0);
  } finally {
    restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('providerMcpService.removeMcpServerFromAllProviders: aggregates a result per provider, tolerating per-provider failures', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-service-all-'));
  const restore = patchHomeDir(tempRoot);

  try {
    const { providerRegistry } = await import('@/modules/providers/provider.registry.js');
    await providerRegistry.resolveProvider('claude').mcp.upsertServer({
      name: 'shared-name',
      scope: 'user',
      transport: 'stdio',
      command: 'npx',
    });

    const results = await providerMcpService.removeMcpServerFromAllProviders({ name: 'shared-name', scope: 'user' });

    // Every registered provider gets an entry, whether it actually had the
    // server (removed: true), didn't (removed: false), or the scope/provider
    // rejects the call outright (error is populated, removed stays false).
    assert.ok(results.length > 0);
    const claudeResult = results.find((r) => r.provider === 'claude');
    assert.equal(claudeResult?.removed, true);
    assert.ok(results.every((r) => typeof r.removed === 'boolean'));
    // At least one provider not supporting "user" scope should have surfaced
    // as a non-throwing, recorded error rather than blowing up the whole loop.
    const errored = results.filter((r) => typeof r.error === 'string');
    for (const entry of errored) {
      assert.equal(entry.removed, false);
      assert.ok(entry.error!.length > 0);
    }
  } finally {
    restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
