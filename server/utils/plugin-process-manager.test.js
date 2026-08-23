import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  isPluginRunning,
  startPluginServer,
  stopAllPlugins,
  terminatePluginProcess,
} from './plugin-process-manager.js';

function fakeProcess() {
  const child = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

test('plugin termination escalates to SIGKILL when SIGTERM is ignored', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeProcess();
  let settled = 0;

  terminatePluginProcess(child, () => { settled += 1; }, 25);
  assert.deepEqual(child.signals, ['SIGTERM']);
  t.mock.timers.tick(25);

  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, 1);
});

test('plugin termination cancels escalation after a clean exit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeProcess();
  let settled = 0;

  terminatePluginProcess(child, () => { settled += 1; }, 25);
  child.emit('exit', 0);
  t.mock.timers.tick(25);

  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(settled, 1);
});

test('stopAllPlugins terminates a child that is still starting', { concurrency: false }, async () => {
  const child = fakeProcess();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  const starting = startPluginServer('starting-test', '/tmp', 'plugin.js', () => child);
  const rejected = assert.rejects(starting, /shutdown started before server became ready/);
  const stopping = stopAllPlugins();
  assert.deepEqual(child.signals, ['SIGTERM']);

  child.stdout.emit('data', Buffer.from('{"ready":true,"port":4567}\n'));
  child.emit('exit', null);
  await Promise.all([rejected, stopping]);

  assert.equal(isPluginRunning('starting-test'), false);
  await assert.rejects(
    startPluginServer('after-shutdown', '/tmp', 'plugin.js', () => fakeProcess()),
    /shutdown is in progress/,
  );
});
