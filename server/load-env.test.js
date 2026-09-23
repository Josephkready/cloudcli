import assert from 'node:assert/strict';
import test from 'node:test';

import { reportEnvLoadError } from './load-env.js';

test('a missing .env is not reported (#536)', () => {
  const lines = [];
  const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/x/.env'"), { code: 'ENOENT' });
  reportEnvLoadError(missing, (...args) => lines.push(args));
  assert.equal(lines.length, 0);
});

test('any other .env read failure is still reported', () => {
  const lines = [];
  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  reportEnvLoadError(denied, (...args) => lines.push(args));
  assert.deepEqual(lines, [['Error reading .env file:', 'EACCES: permission denied']]);
});
