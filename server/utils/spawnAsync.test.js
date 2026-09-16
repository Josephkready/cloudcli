import assert from 'node:assert/strict';
import test from 'node:test';

import { spawnAsync } from './spawnAsync.js';

test('spawnAsync resolves with stdout and stderr on success', async () => {
  const { stdout, stderr } = await spawnAsync(process.execPath, [
    '-e',
    'process.stdout.write("out"); process.stderr.write("err");',
  ]);

  assert.equal(stdout, 'out');
  assert.equal(stderr, 'err');
});

test('spawnAsync rejects on a non-zero exit, carrying code and both streams', async () => {
  const error = await spawnAsync(process.execPath, [
    '-e',
    'process.stdout.write("partial"); process.stderr.write("boom"); process.exit(3);',
  ]).then(
    () => null,
    (rejection) => rejection,
  );

  assert.ok(error, 'expected a rejection');
  assert.match(error.message, /^Command failed: /);
  assert.equal(error.code, 3);
  // The gitConfig copy dropped these, so the same failure reported differently
  // depending on which route ran it.
  assert.equal(error.stdout, 'partial');
  assert.equal(error.stderr, 'boom');
});

test('spawnAsync rejects when the command cannot be spawned', async () => {
  await assert.rejects(spawnAsync('definitely-not-a-real-binary-xyz', []));
});

test('spawnAsync passes options through but never enables a shell', async () => {
  const { stdout } = await spawnAsync(
    process.execPath,
    ['-e', 'process.stdout.write(process.env.SPAWN_ASYNC_PROBE ?? "")'],
    { env: { ...process.env, SPAWN_ASYNC_PROBE: 'visible' } },
  );

  assert.equal(stdout, 'visible');

  // With `shell: true` the metacharacters below would be interpreted; with
  // `shell: false` they arrive as one literal argument.
  const { stdout: literal } = await spawnAsync(process.execPath, [
    '-e',
    'process.stdout.write(process.argv[1])',
    'a; echo pwned',
  ]);

  assert.equal(literal, 'a; echo pwned');
});
