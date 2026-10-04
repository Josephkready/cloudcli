/**
 * Boots a throwaway cloudcli for `vdebug.py record` and keeps it up until Ctrl-C.
 *
 *   npx tsx --tsconfig bench/tsconfig.json vdebug/serve-fixture.ts [--profile small] [--skip-build]
 *       [--port N] [--ios-tunnel [host]]
 *   npm run ios:debug            # = --ios-tunnel (perfbook, port 4870): for `--viewports ios-sim`
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
 *
 * DEBUG/TEST ONLY: no auth, so it only ever binds 127.0.0.1. `--ios-tunnel` makes it reachable
 * from the iOS Simulator on perfbook by SSH reverse-tunnelling the port to perfbook's own
 * loopback (bench/ios-tunnel.ts), never by listening on the LAN; it then prints
 * `VDEBUG_IOS_BASE_URL=http://localhost:<port>` — the URL to give `vdebug.py --viewports ios-sim`
 * (or ios_hub's install_pwa), which resolves on perfbook. A fixed port (default 4870) keeps an
 * already-installed home-screen app pointing at the right place across restarts.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { parseServeFixtureArgs, startIosTunnel, type IosTunnel } from '../bench/ios-tunnel.js';
import { startBenchServer } from '../bench/server.js';

const { profile, skipBuild, port, tunnelHost } = parseServeFixtureArgs(process.argv.slice(2));
const repoRoot = process.cwd();

if (!skipBuild || !existsSync(path.join(repoRoot, 'dist', 'index.html'))) {
  console.error('[vdebug] building client bundle (VITE_AUTH_DISABLED=true)...');
  execFileSync('npm', ['run', 'build:client'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, VITE_AUTH_DISABLED: 'true' },
  });
}

const progress = (message: string) => console.error(`[vdebug] ${message}`);
const server = await startBenchServer({ repoRoot, profile, port, onProgress: progress });
console.log(`VDEBUG_BASE_URL=${server.baseURL}`);

let tunnel: IosTunnel | null = null;
if (tunnelHost !== null) {
  try {
    tunnel = await startIosTunnel({ port: server.port, host: tunnelHost, onProgress: progress });
  } catch (error) {
    await server.stop();
    throw error;
  }
  console.log(`VDEBUG_IOS_BASE_URL=http://localhost:${server.port}`);
  progress(`ios-sim: python3 vdebug/vdebug.py record --base-url http://localhost:${server.port} ` +
           '--viewports ios-sim --flow composer-keyboard');
}
console.error('[vdebug] ready — Ctrl-C (or SIGTERM) stops the server' +
              (tunnel ? ', closes the tunnel' : '') + ' and deletes the fixture HOME');

const shutdown = async () => {
  tunnel?.stop();
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30);
