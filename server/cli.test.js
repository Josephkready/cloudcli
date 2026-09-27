import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression test for a bug where `server/cli.js`'s `start` command (the
// CLI's default command) never actually started the server: server/index.js
// only auto-starts when *it* is the process entry point (`isMainModule()`,
// comparing realpath(process.argv[1]) to its own import.meta.url), and
// cli.js used to rely on that side effect via a bare `await
// import('./index.js')` — which is a no-op when argv[1] is cli.js. This
// spawns the real CLI exactly the way an end user or `npx cloudcli` would,
// and asserts the server actually comes up and answers /health.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, 'cli.js');
const TSX_BIN = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
const TSCONFIG_PATH = path.join(__dirname, 'tsconfig.json');

function findFreePort() {
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
            const res = await fetch(`${baseURL}/health`);
            return res;
        } catch (err) {
            lastError = err;
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    throw new Error(`cli.test: server never answered /health: ${lastError?.message || lastError}`);
}

test('cli.js `start` boots the server and answers /health (regression)', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cloudcli-cli-test-'));
    const dbPath = path.join(home, 'auth.db');
    const port = await findFreePort();
    const baseURL = `http://127.0.0.1:${port}`;

    // Spawned through `tsx` against the real cli.js, exactly like
    // `server:dev`/`npm run usage` do, and like a packaged install would run
    // the compiled dist-server/server/cli.js — not by importing cli.js's
    // internals, since the whole point of this test is to catch a launch-path
    // regression that only shows up on a real process boundary.
    const child = spawn(
        TSX_BIN,
        ['--tsconfig', TSCONFIG_PATH, CLI_PATH, 'start', '--port', String(port), '--database-path', dbPath],
        {
            cwd: path.join(__dirname, '..'),
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
        rmSync(home, { recursive: true, force: true });
    }
});
