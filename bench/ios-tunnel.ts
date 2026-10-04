/**
 * The iOS Simulator half of `vdebug/serve-fixture.ts --ios-tunnel` (`npm run ios:debug`).
 *
 * The Simulator runs on perfbook, a different machine, while the fixture server
 * binds 127.0.0.1 on this one. Rather than expose the debug instance on the LAN
 * (no auth, by design), we reverse-tunnel its port over SSH: perfbook's own
 * 127.0.0.1:<port> forwards to ours. The Simulator shares perfbook's network, so
 * the app opens at http://localhost:<port>/ — loopback, which Safari treats as a
 * secure context, so the service worker and Add to Home Screen behave as they do
 * on the real origin. Both ends stay on loopback; nothing listens on a LAN address.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type { ProfileName } from './seed.js';

export type ServeFixtureArgs = {
  profile: ProfileName;
  skipBuild: boolean;
  /** Fixed loopback port; undefined = any free port (pointless with a tunnel). */
  port?: number;
  /** SSH host to reverse-tunnel the port to, or null for no tunnel. */
  tunnelHost: string | null;
};

export const DEFAULT_TUNNEL_HOST = 'perfbook';
/** Default port for --ios-tunnel: a fixed one, so the installed home-screen app keeps working across restarts. */
export const DEFAULT_IOS_PORT = 4870;
const PROFILES: readonly ProfileName[] = ['small', 'standard', 'large'];
/**
 * An ssh destination: a hostname/alias, optionally `user@`. It becomes an ssh argument, so a
 * value starting with `-` (`-oProxyCommand=...`) would be parsed as an option and run a command.
 */
const TUNNEL_HOST = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * `[--profile small|standard|large] [--skip-build] [--port N] [--ios-tunnel [host]]`.
 * Throws on anything it does not understand: a typo'd flag silently ignored would
 * leave you debugging the wrong instance.
 */
export function parseServeFixtureArgs(argv: readonly string[]): ServeFixtureArgs {
  const out: ServeFixtureArgs = { profile: 'small', skipBuild: false, tunnelHost: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--skip-build') {
      out.skipBuild = true;
    } else if (arg === '--profile') {
      if (!PROFILES.includes(next as ProfileName)) {
        throw new Error(`--profile needs one of ${PROFILES.join(', ')} (got ${next ?? 'nothing'})`);
      }
      out.profile = next as ProfileName;
      i++;
    } else if (arg === '--port') {
      const port = Number(next);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error(`--port needs an integer in 1024-65535 (got ${next ?? 'nothing'})`);
      }
      out.port = port;
      i++;
    } else if (arg === '--ios-tunnel') {
      // The host is optional: `--ios-tunnel` alone means perfbook.
      if (next !== undefined && !next.startsWith('--')) {
        if (!TUNNEL_HOST.test(next)) {
          throw new Error(`--ios-tunnel needs an ssh host or alias like perfbook or user@host (got ${next})`);
        }
        out.tunnelHost = next;
        i++;
      } else {
        out.tunnelHost = DEFAULT_TUNNEL_HOST;
      }
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (out.tunnelHost !== null && out.port === undefined) {
    out.port = DEFAULT_IOS_PORT;
  }
  return out;
}

/** `ssh` arguments for a loopback-to-loopback reverse tunnel of `port` to `host`. */
export function iosTunnelSshArgs(port: number, host: string): string[] {
  return [
    '-N',
    // Fail (instead of running uselessly) when perfbook's end of the port is taken.
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'BatchMode=yes',
    // Explicit 127.0.0.1 on the remote side: never a LAN-facing listener on perfbook.
    '-R', `127.0.0.1:${port}:127.0.0.1:${port}`,
    host,
  ];
}

/** Asks `host` itself whether the tunnelled /health answers — the only proof the Simulator can reach it. */
function verifyFromHost(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', host, `curl -fsS -m 5 http://127.0.0.1:${port}/health`],
      { stdio: 'ignore' },
    );
    probe.on('error', () => resolve(false));
    probe.on('exit', (code) => resolve(code === 0));
  });
}

export type IosTunnel = {
  /** Closes the tunnel. Safe to call twice. */
  stop: () => void;
};

export async function startIosTunnel(options: {
  port: number;
  host: string;
  onProgress?: (message: string) => void;
  /** Test seams: the ssh binary and the end-to-end health probe. */
  sshCommand?: string;
  verify?: (host: string, port: number) => Promise<boolean>;
  attempts?: number;
  intervalMs?: number;
  /** Aborting mid-verification closes the tunnel and rejects (Ctrl-C before it is up). */
  signal?: AbortSignal;
}): Promise<IosTunnel> {
  const { signal } = options;
  signal?.throwIfAborted();
  const report = options.onProgress ?? (() => {});
  const verify = options.verify ?? verifyFromHost;
  const attempts = options.attempts ?? 10;
  const intervalMs = options.intervalMs ?? 1_000;

  report(`opening reverse tunnel: ${options.host}:127.0.0.1:${options.port} -> 127.0.0.1:${options.port}`);
  const child: ChildProcess = spawn(
    options.sshCommand ?? 'ssh',
    iosTunnelSshArgs(options.port, options.host),
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const stderr: string[] = [];
  let exited: string | null = null;
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  child.on('error', (error) => {
    exited = `could not start ssh: ${error.message}`;
  });
  child.on('exit', (code, signal) => {
    exited ??= `ssh exited (${signal ?? code})`;
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (exited === null) child.kill('SIGTERM');
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      signal?.throwIfAborted();
      if (exited !== null) {
        throw new Error(`tunnel to ${options.host} failed: ${exited}. ${stderr.join('').trim()}`.trim());
      }
      const reachable = await verify(options.host, options.port);
      signal?.throwIfAborted();
      if (reachable) {
        report(`tunnel up: ${options.host} reaches the fixture at http://localhost:${options.port}/health`);
        return { stop };
      }
    }
    throw new Error(
      `tunnel to ${options.host} opened, but ${options.host} could not reach ` +
      `http://127.0.0.1:${options.port}/health after ${attempts} attempts`,
    );
  } catch (error) {
    stop();
    throw error;
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

export type FixtureLifecycle = {
  /** Passed to every startup step, so a shutdown mid-startup aborts it (and it cleans up itself). */
  signal: AbortSignal;
  /** Registers teardown for something that has finished starting. Run in reverse order. */
  onShutdown: (cleanup: () => void | Promise<void>) => void;
  /** Aborts startup, runs every registered teardown once, then exits. Idempotent. */
  shutdown: (code?: number) => Promise<void>;
};

/**
 * Teardown for serve-fixture.ts that is valid from the first line: signal handlers go in before
 * anything starts, and whatever has started by the time Ctrl-C lands gets torn down — the
 * finished steps via onShutdown, the in-flight one via the abort signal.
 */
export function createFixtureLifecycle(
  exit: (code: number) => void = (code) => process.exit(code),
  logError: (message: string) => void = (message) => console.error(message),
): FixtureLifecycle {
  const controller = new AbortController();
  const cleanups: Array<() => void | Promise<void>> = [];
  let shuttingDown: Promise<void> | null = null;
  return {
    signal: controller.signal,
    onShutdown: (cleanup) => {
      cleanups.push(cleanup);
    },
    shutdown: (code = 0) => {
      shuttingDown ??= (async () => {
        controller.abort();
        for (const cleanup of cleanups.reverse()) {
          try {
            await cleanup();
          } catch (error) {
            logError(`[vdebug] teardown step failed: ${(error as Error).message}`);
          }
        }
        exit(code);
      })();
      return shuttingDown;
    },
  };
}
