import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  createFixtureLifecycle,
  DEFAULT_IOS_PORT,
  iosTunnelSshArgs,
  parseServeFixtureArgs,
  startIosTunnel,
} from './ios-tunnel.js';

/*
 * The debug instance has no auth by design, so the one property worth pinning
 * is that both ends of the tunnel stay on loopback. The rest is argument
 * handling, where a silently ignored flag means debugging the wrong instance.
 */

describe('parseServeFixtureArgs', () => {
  it('defaults to the small profile, a build, a free port and no tunnel', () => {
    assert.deepEqual(parseServeFixtureArgs([]), { profile: 'small', skipBuild: false, tunnelHost: null });
  });

  it('--ios-tunnel alone means perfbook on the fixed default port', () => {
    const args = parseServeFixtureArgs(['--ios-tunnel']);
    assert.equal(args.tunnelHost, 'perfbook');
    assert.equal(args.port, DEFAULT_IOS_PORT);
  });

  it('takes an explicit tunnel host and port, in any order', () => {
    const args = parseServeFixtureArgs(['--port', '4910', '--ios-tunnel', 'macmini', '--skip-build']);
    assert.deepEqual(args, { profile: 'small', skipBuild: true, port: 4910, tunnelHost: 'macmini' });
  });

  it('does not swallow the next flag as a tunnel host', () => {
    const args = parseServeFixtureArgs(['--ios-tunnel', '--profile', 'standard']);
    assert.equal(args.tunnelHost, 'perfbook');
    assert.equal(args.profile, 'standard');
  });

  it('rejects unknown flags, bad profiles and out-of-range ports', () => {
    assert.throws(() => parseServeFixtureArgs(['--tunnel']), /unknown argument --tunnel/);
    assert.throws(() => parseServeFixtureArgs(['--profile', 'huge']), /--profile needs one of/);
    assert.throws(() => parseServeFixtureArgs(['--port', '80']), /1024-65535/);
    assert.throws(() => parseServeFixtureArgs(['--port']), /got nothing/);
  });

  it('accepts ssh aliases, hostnames and user@host as the tunnel host', () => {
    for (const host of ['perfbook', 'mac-mini.local', 'jk@10.0.0.5', 'my_host']) {
      assert.equal(parseServeFixtureArgs(['--ios-tunnel', host]).tunnelHost, host);
    }
  });

  it('rejects a tunnel host ssh would parse as an option, or that is not host-shaped', () => {
    // `-oProxyCommand=...` as ssh's destination argument would run an arbitrary command.
    for (const host of ['-oProxyCommand=touch /tmp/pwned', '-p', 'perf book', 'host;id', 'a@-b', '@host', '']) {
      assert.throws(() => parseServeFixtureArgs(['--ios-tunnel', host]), /--ios-tunnel needs an ssh host/, host);
    }
  });
});

describe('iosTunnelSshArgs', () => {
  it('forwards loopback to loopback and fails fast when the remote port is taken', () => {
    const args = iosTunnelSshArgs(4910, 'perfbook');
    assert.ok(args.includes('127.0.0.1:4910:127.0.0.1:4910'), 'remote bind must be explicit 127.0.0.1');
    assert.ok(args.includes('ExitOnForwardFailure=yes'));
    assert.ok(args.includes('BatchMode=yes'), 'never block on a password prompt');
    assert.equal(args.at(-1), 'perfbook');
  });
});

describe('startIosTunnel', () => {
  // Stands in for `ssh -N`: ignores its arguments and stays up until killed.
  const fakeSsh = path.join(mkdtempSync(path.join(os.tmpdir(), 'ios-tunnel-test-')), 'ssh');
  writeFileSync(fakeSsh, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(fakeSsh, 0o755);

  it('resolves once the far end can reach the fixture, and stop() is idempotent', async () => {
    let probes = 0;
    const tunnel = await startIosTunnel({
      port: 4910, host: 'perfbook', sshCommand: fakeSsh, verify: async () => ++probes >= 2, intervalMs: 10,
    });
    assert.equal(probes, 2, 'keeps probing until the far end answers');
    tunnel.stop();
    tunnel.stop();
  });

  it('reports an ssh that exits before the tunnel is verified', async () => {
    await assert.rejects(
      startIosTunnel({ port: 4910, host: 'perfbook', sshCommand: 'false', verify: async () => false, intervalMs: 50 }),
      /tunnel to perfbook failed: ssh exited \(1\)/,
    );
  });

  it('gives up (and closes the tunnel) when the far end never answers', async () => {
    await assert.rejects(
      startIosTunnel({
        port: 4910, host: 'perfbook', sshCommand: fakeSsh, verify: async () => false, attempts: 2, intervalMs: 10,
      }),
      /could not reach http:\/\/127\.0\.0\.1:4910\/health after 2 attempts/,
    );
  });

  it('an abort mid-verification closes the tunnel and rejects', async () => {
    const controller = new AbortController();
    let probes = 0;
    await assert.rejects(
      startIosTunnel({
        port: 4910, host: 'perfbook', sshCommand: fakeSsh, intervalMs: 10, attempts: 1000,
        verify: async () => {
          if (++probes === 3) controller.abort();
          return false;
        },
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
    assert.equal(probes, 3, 'stops probing once aborted');
  });

  it('an abort during a slow probe kills ssh at once, not when the probe returns', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ios-tunnel-test-'));
    const pidSsh = path.join(dir, 'ssh');
    writeFileSync(pidSsh, `#!/bin/sh\necho $$ > ${dir}/pid\nexec sleep 30\n`);
    chmodSync(pidSsh, 0o755);
    const controller = new AbortController();
    let killedDuringProbe = false;
    await assert.rejects(
      startIosTunnel({
        port: 4910, host: 'perfbook', sshCommand: pidSsh, intervalMs: 50, signal: controller.signal,
        verify: async () => {
          const pid = Number(readFileSync(path.join(dir, 'pid'), 'utf8'));
          controller.abort();
          for (let i = 0; i < 100 && !killedDuringProbe; i++) {
            try {
              process.kill(pid, 0);
              await new Promise((resolve) => setTimeout(resolve, 20));
            } catch {
              killedDuringProbe = true;
            }
          }
          return true;
        },
      }),
      { name: 'AbortError' },
    );
    assert.ok(killedDuringProbe, 'ssh must be gone while the probe is still running');
  });
});

describe('createFixtureLifecycle', () => {
  it('aborts the in-flight step, tears down finished ones in reverse, and exits once', async () => {
    const order: string[] = [];
    const exits: number[] = [];
    const lifecycle = createFixtureLifecycle((code) => exits.push(code), () => {});
    lifecycle.signal.addEventListener('abort', () => order.push('abort'));
    lifecycle.onShutdown(() => {
      order.push('server');
    });
    lifecycle.onShutdown(async () => {
      order.push('tunnel');
    });
    await Promise.all([lifecycle.shutdown(0), lifecycle.shutdown(1)]);
    await lifecycle.shutdown(0);
    assert.deepEqual(order, ['abort', 'tunnel', 'server']);
    assert.deepEqual(exits, [0]);
  });

  it('a failing teardown step does not skip the rest', async () => {
    const order: string[] = [];
    const errors: string[] = [];
    const lifecycle = createFixtureLifecycle(() => order.push('exit'), (message) => errors.push(message));
    lifecycle.onShutdown(() => {
      order.push('server');
    });
    lifecycle.onShutdown(() => {
      throw new Error('ssh already gone');
    });
    await lifecycle.shutdown();
    assert.deepEqual(order, ['server', 'exit']);
    assert.match(errors[0], /ssh already gone/);
  });
});
