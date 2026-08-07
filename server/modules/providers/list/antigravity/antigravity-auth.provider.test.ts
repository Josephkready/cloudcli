import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AntigravityProviderAuth } from './antigravity-auth.provider.js';

test('Antigravity auth checks the configured agy executable', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'antigravity-auth-'));
  const binDir = path.join(tempRoot, 'bin');
  const scriptPath = path.join(binDir, 'agy.js');
  const commandPath = path.join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy');

  try {
    await mkdir(binDir);
    await writeFile(scriptPath, `
const command = process.argv[2];
if (command === '--version') process.exit(0);
if (command === 'models') { console.log('gemini-test'); process.exit(0); }
process.exit(1);
`, 'utf8');
    if (process.platform === 'win32') {
      await writeFile(commandPath, '@echo off\r\nnode "%~dp0agy.js" %*\r\n', 'utf8');
    } else {
      await writeFile(commandPath, '#!/bin/sh\nnode "$(dirname "$0")/agy.js" "$@"\n', 'utf8');
      await chmod(commandPath, 0o755);
    }

    const status = await new AntigravityProviderAuth({
      executable: commandPath,
      env: { ...process.env },
    }).getStatus();

    assert.equal(status.installed, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'agy');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
