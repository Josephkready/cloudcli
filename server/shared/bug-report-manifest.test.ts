import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { PreparedAttachment } from './bug-report-attachments.js';
import { withAttachmentsManifest } from './bug-report-manifest.js';

function attachment(overrides: Partial<PreparedAttachment> = {}): PreparedAttachment {
  return { name: 'shot.jpg', mime: 'image/jpeg', bytes: Buffer.from('jpeg-bytes'), ...overrides };
}

test('withAttachmentsManifest calls run(undefined) and writes nothing when there are no attachments', async () => {
  const paths: (string | undefined)[] = [];
  const result = await withAttachmentsManifest([], async (manifestPath) => {
    paths.push(manifestPath);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(paths, [undefined]);
});

test('withAttachmentsManifest writes a manifest naming a real temp file per attachment, readable during the call', async () => {
  const seen: { manifestPath: string; manifest: Array<{ path: string; name: string }>; existedDuringCall: boolean[] } = {
    manifestPath: '',
    manifest: [],
    existedDuringCall: [],
  };

  await withAttachmentsManifest([attachment({ name: 'shot.jpg' })], async (manifestPath) => {
    assert.ok(manifestPath);
    seen.manifestPath = manifestPath as string;
    const manifest = JSON.parse(await readFile(manifestPath as string, 'utf8'));
    seen.manifest = manifest;
    seen.existedDuringCall = manifest.map((entry: { path: string }) => existsSync(entry.path));
    return 'queued';
  });

  assert.equal(seen.manifest.length, 1);
  assert.equal(seen.manifest[0].name, 'shot.jpg');
  assert.deepEqual(seen.existedDuringCall, [true]);
  // Cleaned up after the call returns — issue-queue already durably owns the bytes by then.
  assert.equal(existsSync(seen.manifest[0].path), false);
  assert.equal(existsSync(seen.manifestPath), false);
});

test('withAttachmentsManifest lists every attachment, with distinct paths and bytes, in a multi-attachment batch', async () => {
  const shots = [
    attachment({ name: 'a.jpg', bytes: Buffer.from('bytes-a') }),
    attachment({ name: 'b.jpg', bytes: Buffer.from('bytes-b') }),
    attachment({ name: 'c.jpg', bytes: Buffer.from('bytes-c') }),
  ];

  const seen: { manifest: Array<{ path: string; name: string }>; fileBytes: string[] } = {
    manifest: [],
    fileBytes: [],
  };
  await withAttachmentsManifest(shots, async (manifestPath) => {
    const manifest = JSON.parse(await readFile(manifestPath as string, 'utf8'));
    seen.manifest = manifest;
    seen.fileBytes = await Promise.all(
      manifest.map((entry: { path: string }) => readFile(entry.path, 'utf8')),
    );
    return null;
  });

  assert.equal(seen.manifest.length, 3);
  assert.deepEqual(seen.manifest.map((entry) => entry.name), ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.deepEqual(seen.fileBytes, ['bytes-a', 'bytes-b', 'bytes-c']);
  // Every attachment gets its OWN temp file, not one shared/overwritten path.
  assert.equal(new Set(seen.manifest.map((entry) => entry.path)).size, 3);
  // All cleaned up after the call returns.
  for (const entry of seen.manifest) {
    assert.equal(existsSync(entry.path), false);
  }
});

test('withAttachmentsManifest writes the exact bytes handed to it', async () => {
  const bytes = Buffer.from('exact jpeg bytes');
  let seenBytes: Buffer | null = null;
  await withAttachmentsManifest([attachment({ bytes })], async (manifestPath) => {
    const manifest = JSON.parse(await readFile(manifestPath as string, 'utf8'));
    seenBytes = await readFile(manifest[0].path);
    return null;
  });
  assert.ok(seenBytes);
  assert.ok((seenBytes as Buffer).equals(bytes));
});

test('withAttachmentsManifest cleans up temp files even when run() throws', async () => {
  let capturedPath: string | undefined;
  await assert.rejects(
    withAttachmentsManifest([attachment()], async (manifestPath) => {
      capturedPath = manifestPath;
      const manifest = JSON.parse(await readFile(manifestPath as string, 'utf8'));
      assert.equal(existsSync(manifest[0].path), true);
      throw new Error('cli failed');
    }),
    /cli failed/,
  );
  assert.ok(capturedPath);
  assert.equal(existsSync(capturedPath as string), false);
});

test('withAttachmentsManifest never passes a manifest for a single attachment named oddly', async () => {
  // Sanity: a manifest is written for exactly one attachment too (not just >=2).
  let manifestPath: string | undefined;
  await withAttachmentsManifest([attachment()], async (path) => {
    manifestPath = path;
    return null;
  });
  assert.ok(manifestPath);
});

test('withAttachmentsManifest leaks no temp file when writing a later attachment fails', async () => {
  const writtenPaths: string[] = [];
  let calls = 0;
  const failingWriter = async (filePath: string, bytes: Buffer) => {
    calls += 1;
    if (calls === 2) {
      // Simulate the underlying write failing AFTER the path was already
      // registered for cleanup by the caller — no file exists at this path.
      throw new Error('simulated disk failure');
    }
    writtenPaths.push(filePath);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, bytes, { mode: 0o600 });
  };

  await assert.rejects(
    withAttachmentsManifest(
      [attachment({ name: 'a.jpg' }), attachment({ name: 'b.jpg' })],
      async () => 'unreachable',
      failingWriter,
    ),
    /simulated disk failure/,
  );

  // The first attachment's real file must not survive the failure of the second.
  assert.equal(writtenPaths.length, 1);
  assert.equal(existsSync(writtenPaths[0]), false);
});
