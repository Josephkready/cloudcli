import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AntigravityProviderAuth } from './antigravity-auth.provider.js';

const findEnvKey = (name: string) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

test('Antigravity auth finds agy in a user executable directory', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'antigravity-auth-'));
  const binDir = path.join(tempRoot, 'bin');
  const scriptPath = path.join(binDir, 'agy.js');
  const commandPath = path.join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
  const pathKey = findEnvKey('PATH');
  const previousPath = process.env[pathKey];
  const previousPrefix = process.env.npm_config_prefix;
  const previousExecutable = process.env.ANTIGRAVITY_CLI_PATH;

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

    process.env[pathKey] = '/usr/bin';
    process.env.npm_config_prefix = tempRoot;
    process.env.ANTIGRAVITY_CLI_PATH = commandPath;
    const status = await new AntigravityProviderAuth().getStatus();

    assert.equal(status.installed, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'agy');
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (previousPrefix === undefined) delete process.env.npm_config_prefix;
    else process.env.npm_config_prefix = previousPrefix;
    if (previousExecutable === undefined) delete process.env.ANTIGRAVITY_CLI_PATH;
    else process.env.ANTIGRAVITY_CLI_PATH = previousExecutable;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
