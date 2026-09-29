/**
 * Boots a throwaway cloudcli for `vdebug.py record` and keeps it up until Ctrl-C.
 *
 *   npx tsx --tsconfig bench/tsconfig.json vdebug/serve-fixture.ts [--profile small] [--skip-build]
 *
 * Reuses the benchmark's harness (bench/server.ts) verbatim, so the app under test is:
 *   - a synthetic, deterministic transcript library in a temp HOME under /var/tmp
 *     (never your real ~/.claude sessions or projects),
 *   - a throwaway SQLite DB, auth disabled, a free port on 127.0.0.1,
 *   - AGENT_MOCK_PROVIDER=true — chat turns are answered by the in-process mock;
 *     no real Claude/Codex session is ever started,
 *   - AI titles off (no network calls).
 *
 * The client bundle is built with VITE_AUTH_DISABLED=true first (a Vite build-time
 * constant), unless --skip-build and an auth-disabled dist/ already exists.
 * Prints `VDEBUG_BASE_URL=http://127.0.0.1:<port>` once the index is warm.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { startBenchServer } from '../bench/server.js';
import type { ProfileName } from '../bench/seed.js';

const args = process.argv.slice(2);
const profileIndex = args.indexOf('--profile');
const profile = (profileIndex >= 0 ? args[profileIndex + 1] : 'small') as ProfileName;
const skipBuild = args.includes('--skip-build');
const repoRoot = process.cwd();

if (!skipBuild || !existsSync(path.join(repoRoot, 'dist', 'index.html'))) {
  console.error('[vdebug] building client bundle (VITE_AUTH_DISABLED=true)...');
  execFileSync('npm', ['run', 'build:client'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, VITE_AUTH_DISABLED: 'true' },
  });
}

const server = await startBenchServer({
  repoRoot,
  profile,
  onProgress: (message) => console.error(`[vdebug] ${message}`),
});
console.log(`VDEBUG_BASE_URL=${server.baseURL}`);
console.error('[vdebug] ready — Ctrl-C (or SIGTERM) stops the server and deletes the fixture HOME');

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30);
