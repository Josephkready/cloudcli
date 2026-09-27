import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseArgs,
  showStatus,
  showUsage,
  showHelp,
  showVersion,
  formatLastUsed,
  getDatabasePath,
  getInstallDir,
  isMainModule,
  main,
} from './cli.js';

// cli.js's top-level `main().catch(...)` is now guarded by `isMainModule()`
// (import.meta.url vs. process.argv[1]) specifically so this file can import
// it for direct unit testing without spawning a real server or exiting the
// test process. See the comment above that guard in cli.js.

function captureConsole(t) {
  const logs = [];
  t.mock.method(console, 'log', (...args) => {
    logs.push(args.join(' '));
  });
  return logs;
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs defaults to the "start" command with no options', () => {
  assert.deepEqual(parseArgs([]), { command: 'start', options: {} });
});

test('parseArgs reads --port/-p (space and = forms)', () => {
  assert.equal(parseArgs(['--port', '8080']).options.serverPort, '8080');
  assert.equal(parseArgs(['-p', '9090']).options.serverPort, '9090');
  assert.equal(parseArgs(['--port=7070']).options.serverPort, '7070');
});

test('parseArgs reads --database-path (space and = forms)', () => {
  assert.equal(parseArgs(['--database-path', '/tmp/db']).options.databasePath, '/tmp/db');
  assert.equal(parseArgs(['--database-path=/tmp/other']).options.databasePath, '/tmp/other');
});

test('parseArgs reads --json and --clear flags', () => {
  const parsed = parseArgs(['usage', '--json', '--clear']);
  assert.equal(parsed.command, 'usage');
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.clear, true);
});

test('parseArgs maps --help/-h and --version/-v to their commands', () => {
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['-h']).command, 'help');
  assert.equal(parseArgs(['--version']).command, 'version');
  assert.equal(parseArgs(['-v']).command, 'version');
});

test('parseArgs treats the first non-flag token as the command', () => {
  assert.equal(parseArgs(['status']).command, 'status');
  assert.equal(parseArgs(['status', 'extra']).command, 'extra'); // last non-flag wins, matching the loop
});

// ---------------------------------------------------------------------------
// formatLastUsed
// ---------------------------------------------------------------------------

test('formatLastUsed reports "never" for a falsy timestamp', () => {
  assert.equal(formatLastUsed(null), 'never');
  assert.equal(formatLastUsed(''), 'never');
});

test('formatLastUsed returns the raw string when it fails to parse', () => {
  assert.equal(formatLastUsed('not-a-date'), 'not-a-date');
});

test('formatLastUsed reports "today" for a timestamp from the last 24h', () => {
  const now = new Date();
  const sqliteTimestamp = now.toISOString().slice(0, 19).replace('T', ' ');
  assert.match(formatLastUsed(sqliteTimestamp), /\(today\)$/);
});

test('formatLastUsed reports "N days ago" for an older timestamp', () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
  const sqliteTimestamp = threeDaysAgo.toISOString().slice(0, 19).replace('T', ' ');
  assert.match(formatLastUsed(sqliteTimestamp), /\(3 days ago\)$/);
});

test('formatLastUsed reports "1 day ago" (singular) for yesterday', () => {
  const yesterday = new Date(Date.now() - 1 * 86_400_000 - 60_000);
  const sqliteTimestamp = yesterday.toISOString().slice(0, 19).replace('T', ' ');
  assert.match(formatLastUsed(sqliteTimestamp), /\(1 day ago\)$/);
});

// ---------------------------------------------------------------------------
// getDatabasePath / getInstallDir
// ---------------------------------------------------------------------------

test('getDatabasePath returns DATABASE_PATH when set, else the ~/.cloudcli default', () => {
  const original = process.env.DATABASE_PATH;
  try {
    process.env.DATABASE_PATH = '/tmp/custom/auth.db';
    assert.equal(getDatabasePath(), '/tmp/custom/auth.db');

    delete process.env.DATABASE_PATH;
    assert.match(getDatabasePath(), /\.cloudcli[/\\]auth\.db$/);
  } finally {
    if (original === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = original;
    }
  }
});

test('getInstallDir returns the resolved app root', () => {
  const installDir = getInstallDir();
  assert.equal(typeof installDir, 'string');
  assert.ok(installDir.length > 0);
});

// ---------------------------------------------------------------------------
// isMainModule
// ---------------------------------------------------------------------------

test('isMainModule is false for this test process (argv[1] is the test runner, not cli.js)', () => {
  assert.equal(isMainModule(), false);
});

// import.meta.url is resolved through symlinks by Node, but
// path.resolve(process.argv[1]) is not -- comparing those directly (the old
// implementation) made a symlinked invocation silently skip main(). Invoke
// cli.js through a symlink with plain `node` and confirm it still runs.
test('invoking cli.js through a symlink still runs main() (help output)', async (t) => {
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const tempDir = await mkdtemp(path.join(tmpdir(), 'cli-symlink-'));
  const linkPath = path.join(tempDir, 'cloudcli-link.js');
  try {
    await symlink(cliPath, linkPath);
    const result = spawnSync(process.execPath, [linkPath, 'help'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Commands:/);
    assert.match(result.stdout, /cloudcli usage/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// showHelp / showVersion / showStatus (console output)
// ---------------------------------------------------------------------------

test('showHelp prints usage text including commands and options', (t) => {
  const logs = captureConsole(t);
  showHelp();
  const output = logs.join('\n');
  assert.match(output, /Commands:/);
  assert.match(output, /cloudcli usage/);
  assert.match(output, /--database-path/);
});

test('showVersion prints the package.json version', (t) => {
  const logs = captureConsole(t);
  showVersion();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\d+\.\d+\.\d+/);
});

test('showStatus prints installation, database, and config info', (t) => {
  const originalDbPath = process.env.DATABASE_PATH;
  const logs = captureConsole(t);
  try {
    process.env.DATABASE_PATH = '/definitely/does/not/exist/auth.db';
    showStatus();
    const output = logs.join('\n');
    assert.match(output, /CloudCLI UI - Status/);
    assert.match(output, /Installation Directory/);
    assert.match(output, /Database Location/);
    assert.match(output, /Not created yet/);
    assert.match(output, /Configuration:/);
  } finally {
    if (originalDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = originalDbPath;
    }
  }
});

// ---------------------------------------------------------------------------
// showUsage (real temp sqlite DB)
// ---------------------------------------------------------------------------

async function withTempFeatureUsageDb(fn) {
  const originalDbPath = process.env.DATABASE_PATH;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'cli-usage-'));
  const dbPath = path.join(tempDir, 'auth.db');

  const { closeConnection } = await import('./modules/database/connection.js');
  const { initializeDatabase } = await import('./modules/database/init-db.js');
  const { featureUsageDb } = await import('./modules/database/index.js');

  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  await initializeDatabase();

  try {
    await fn({ featureUsageDb });
  } finally {
    closeConnection();
    if (originalDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = originalDbPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('showUsage (text) lists every feature key, flags never-used entries, and reports a total', async (t) => {
  await withTempFeatureUsageDb(async ({ featureUsageDb }) => {
    featureUsageDb.recordFeatureUses(['chat.voice_input', 'chat.voice_input', 'settings.tab.appearance']);
    const logs = captureConsole(t);

    await showUsage({});

    const output = logs.join('\n');
    assert.match(output, /FEATURE/);
    assert.match(output, /chat.voice_input/);
    assert.match(output, /features never used\./);
  });
});

test('showUsage --json prints a parseable enabled/entries payload', async (t) => {
  await withTempFeatureUsageDb(async ({ featureUsageDb }) => {
    featureUsageDb.recordFeatureUses(['settings.tab.appearance']);
    const logs = captureConsole(t);

    await showUsage({ json: true });

    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assert.equal(typeof parsed.enabled, 'boolean');
    assert.ok(Array.isArray(parsed.entries));
    const darkMode = parsed.entries.find((e) => e.featureKey === 'settings.tab.appearance');
    assert.equal(darkMode.useCount, 1);
  });
});

// ---------------------------------------------------------------------------
// main() dispatch
// ---------------------------------------------------------------------------

async function withMainArgs(t, args, fn) {
  const originalArgv = process.argv;
  const originalServerPort = process.env.SERVER_PORT;
  const originalPort = process.env.PORT;
  const originalDbPath = process.env.DATABASE_PATH;
  process.argv = [originalArgv[0], originalArgv[1], ...args];
  try {
    await fn();
  } finally {
    process.argv = originalArgv;
    if (originalServerPort === undefined) delete process.env.SERVER_PORT; else process.env.SERVER_PORT = originalServerPort;
    if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
    if (originalDbPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = originalDbPath;
  }
}

test('main() dispatches "status" and applies --port/--database-path to env vars', async (t) => {
  captureConsole(t);
  await withMainArgs(t, ['status', '--port', '5555', '--database-path', '/tmp/from-cli.db'], async () => {
    await main();
    assert.equal(process.env.SERVER_PORT, '5555');
    assert.equal(process.env.DATABASE_PATH, '/tmp/from-cli.db');
  });
});

test('main() dispatches "help"/"version"/"info" aliases', async (t) => {
  const logs = captureConsole(t);
  await withMainArgs(t, ['help'], async () => { await main(); });
  assert.match(logs.join('\n'), /Commands:/);

  logs.length = 0;
  await withMainArgs(t, ['version'], async () => { await main(); });
  assert.match(logs[0], /^\d+\.\d+\.\d+/);

  logs.length = 0;
  await withMainArgs(t, ['info'], async () => { await main(); });
  assert.match(logs.join('\n'), /CloudCLI UI - Status/);
});

test('main() falls back to PORT when SERVER_PORT is unset and no --port is given', async (t) => {
  captureConsole(t);
  const originalPort = process.env.PORT;
  process.env.PORT = '4321';
  try {
    await withMainArgs(t, ['status'], async () => {
      await main();
      assert.equal(process.env.SERVER_PORT, '4321');
    });
  } finally {
    if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  }
});

test('main() exits 1 and prints an error for an unknown command', async (t) => {
  const logs = captureConsole(t);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.mock.method(process, 'exit', () => {
    throw new Error('__process_exit__');
  });

  await withMainArgs(t, ['bogus-command'], async () => {
    await assert.rejects(main(), /__process_exit__/);
  });

  assert.match(errors.join('\n'), /Unknown command: bogus-command/);
  assert.match(logs.join('\n'), /cloudcli help/);
});

test('showUsage --clear removes stored counters and reports how many', async (t) => {
  await withTempFeatureUsageDb(async ({ featureUsageDb }) => {
    featureUsageDb.recordFeatureUses(['settings.tab.appearance', 'chat.voice_input']);
    const logs = captureConsole(t);

    await showUsage({ clear: true });

    assert.match(logs.join('\n'), /Cleared 2 feature-usage rows\./);
    const afterClear = featureUsageDb.listUsage();
    assert.ok(afterClear.every((e) => e.useCount === 0));
  });
});

// ---------------------------------------------------------------------------
// start command — real process boundary regression test
// ---------------------------------------------------------------------------
//
// Everything above exercises cli.js's internals directly (parseArgs,
// showStatus, main() dispatch, etc.) by importing the module, which is fast
// but cannot catch a bug that only exists at a real process boundary: index.js
// only auto-starts the server when *it* is the process entry point
// (isMainModule(), comparing realpath(process.argv[1]) to its own
// import.meta.url). cli.js's `start` command used to do a bare
// `await import('./index.js')`, relying on that auto-start side effect —
// which is a no-op once argv[1] is cli.js, so `node server/cli.js` /
// `node dist-server/server/cli.js [start]` silently never started the
// server. Only a real spawn of cli.js reproduces that.

async function findFreePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('cli.test: could not determine a free port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseURL, { timeoutMs = 20_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetch(`${baseURL}/health`);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`cli.test: server never answered /health: ${lastError?.message || lastError}`);
}

test('cli.js `start` boots the server and answers /health (regression)', async () => {
  const { spawn } = await import('node:child_process');
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const tsconfigPath = path.join(repoRoot, 'server', 'tsconfig.json');

  const home = await mkdtemp(path.join(tmpdir(), 'cloudcli-cli-test-'));
  const dbPath = path.join(home, 'auth.db');
  const port = await findFreePort();
  const baseURL = `http://127.0.0.1:${port}`;

  // Spawned through `tsx` against the real cli.js, the same way
  // `server:dev`/`npm run usage` do, and the way a packaged install runs the
  // compiled dist-server/server/cli.js — not by calling cli.js's exported
  // main()/startServer() in-process, since the whole point is to catch a
  // launch-path regression that only shows up on a real process boundary.
  const child = spawn(
    tsxBin,
    ['--tsconfig', tsconfigPath, cliPath, 'start', '--port', String(port), '--database-path', dbPath],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: home,
        HOST: '127.0.0.1',
        VITE_AUTH_DISABLED: 'true',
        AGENT_MOCK_PROVIDER: 'true',
        JWT_SECRET: 'cli-test-secret',
      },
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  try {
    const res = await waitForHealth(baseURL);
    assert.equal(res.status, 200, `expected /health to return 200, got ${res.status}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  } finally {
    child.kill('SIGTERM');
    const result = await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!result) {
      child.kill('SIGKILL');
    }
    await rm(home, { recursive: true, force: true });
  }
});
