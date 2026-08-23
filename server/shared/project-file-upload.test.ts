import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupUploadedTempFiles,
  processProjectUpload,
  type TemporaryUploadFile,
} from './project-file-upload.js';

test('unsafe mixed upload batches write nothing and clean every temporary file', async (t) => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cloudcli-upload-test-'));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const externalRoot = path.join(root, 'external');
  const tempRoot = path.join(root, 'multipart');
  await Promise.all([
    fsPromises.mkdir(projectRoot),
    fsPromises.mkdir(externalRoot),
    fsPromises.mkdir(tempRoot),
  ]);
  await fsPromises.symlink(externalRoot, path.join(projectRoot, 'escape'));

  const tempPaths = [path.join(tempRoot, 'valid'), path.join(tempRoot, 'unsafe')];
  await Promise.all(tempPaths.map((tempPath) => fsPromises.writeFile(tempPath, 'payload')));
  const files: TemporaryUploadFile[] = tempPaths.map((tempPath, index) => ({
    originalname: `${index}.txt`,
    path: tempPath,
    size: 7,
    mimetype: 'text/plain',
  }));

  const result = await processProjectUpload({
    projectRoot,
    resolvedTargetDir: projectRoot,
    files,
    relativePaths: ['valid.txt', 'escape/leak.txt'],
  });

  assert.deepEqual(result, { ok: false, rejectedFiles: ['escape/leak.txt'] });
  await assert.rejects(fsPromises.access(path.join(projectRoot, 'valid.txt')));
  await assert.rejects(fsPromises.access(path.join(externalRoot, 'leak.txt')));
  await Promise.all(tempPaths.map((tempPath) => assert.rejects(fsPromises.access(tempPath))));
});

test('temporary-file cleanup reports aggregate failures without logging paths', async (t) => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cloudcli-upload-test-'));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));

  await cleanupUploadedTempFiles([{
    originalname: 'private.txt',
    path: root,
    size: 0,
    mimetype: 'text/plain',
  }], 'test cleanup');

  assert.deepEqual(warnings, [[
    'Failed to clean up temporary upload files',
    { context: 'test cleanup', failedFileCount: 1 },
  ]]);
  assert.equal(JSON.stringify(warnings).includes(root), false);
});
