import assert from 'node:assert/strict';
import { promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';

import {
  getLocalServerMarkerPath,
  removeLocalServerMarker,
  writeLocalServerMarker,
} from '@/shared/local-server-marker.js';

async function withScratchDir(fn: (dir: string) => Promise<void>) {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'local-server-marker-test-'));
  try {
    await fn(dir);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
}

test('getLocalServerMarkerPath nests under .cloudcli in the given home dir', () => {
  assert.equal(
    getLocalServerMarkerPath('/home/user'),
    path.join('/home/user', '.cloudcli', 'local-server.json'),
  );
});

test('writeLocalServerMarker creates the parent dir and writes JSON with a stamped updatedAt', async () => {
  await withScratchDir(async (dir) => {
    const markerPath = getLocalServerMarkerPath(dir);
    await writeLocalServerMarker(markerPath, {
      pid: 12345,
      host: '0.0.0.0',
      port: 3001,
      url: 'http://localhost:3001',
      installMode: 'npm',
      appRoot: '/opt/cloudcli',
    });

    const raw = await fsPromises.readFile(markerPath, 'utf8');
    const marker = JSON.parse(raw);
    assert.equal(marker.pid, 12345);
    assert.equal(marker.port, 3001);
    assert.equal(typeof marker.updatedAt, 'string');
  });
});

test('removeLocalServerMarker deletes the marker when the pid matches', async () => {
  await withScratchDir(async (dir) => {
    const markerPath = getLocalServerMarkerPath(dir);
    await writeLocalServerMarker(markerPath, {
      pid: process.pid,
      host: '0.0.0.0',
      port: 3001,
      url: 'http://localhost:3001',
      installMode: 'npm',
      appRoot: '/opt/cloudcli',
    });

    await removeLocalServerMarker(markerPath, process.pid);

    await assert.rejects(() => fsPromises.readFile(markerPath, 'utf8'));
  });
});

test('removeLocalServerMarker leaves a newer instance\'s marker alone when the pid differs', async () => {
  await withScratchDir(async (dir) => {
    const markerPath = getLocalServerMarkerPath(dir);
    await writeLocalServerMarker(markerPath, {
      pid: process.pid + 1,
      host: '0.0.0.0',
      port: 3001,
      url: 'http://localhost:3001',
      installMode: 'npm',
      appRoot: '/opt/cloudcli',
    });

    await removeLocalServerMarker(markerPath, process.pid);

    const raw = await fsPromises.readFile(markerPath, 'utf8');
    assert.equal(JSON.parse(raw).pid, process.pid + 1);
  });
});

test('removeLocalServerMarker is a no-op when the marker does not exist', async () => {
  await withScratchDir(async (dir) => {
    const markerPath = getLocalServerMarkerPath(dir);
    await assert.doesNotReject(() => removeLocalServerMarker(markerPath, process.pid));
  });
});
