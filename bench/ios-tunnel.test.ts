import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
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
});
