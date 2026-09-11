/**
 * Writes bug-report screenshot bytes to temp files and a small JSON manifest
 * for the `issue-queue enqueue --attachments-manifest` flag (dante-config
 * skills/bug-report-button/SKILL.md §9).
 *
 * Bytes travel through temp files, never argv — the same reason the issue
 * body already travels over stdin rather than as an argument: three
 * compressed images can total several MB, well past a comfortable argv size.
 * `issue-queue` durably copies the bytes into its OWN storage before it ever
 * answers, so nothing written here needs to survive past the one enqueue
 * call — every temp file this module creates is removed once `run` settles,
 * whether it resolves or rejects.
 */
import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { PreparedAttachment } from '@/shared/bug-report-attachments.js';

/** Writes one attachment's bytes to `filePath`, mode 0600. Overridable for tests. */
export type AttachmentFileWriter = (filePath: string, bytes: Buffer) => Promise<void>;

async function defaultWriteAttachmentFile(filePath: string, bytes: Buffer): Promise<void> {
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

/**
 * Writes `attachments` to temp files plus a manifest naming them, invokes
 * `run` with the manifest path (or `undefined` when there are no
 * attachments, so `run` never has to special-case "a manifest with zero
 * entries"), and removes every temp file this call created before returning
 * — regardless of whether `run` succeeds or throws.
 *
 * Each temp file's path is pushed onto the cleanup list BEFORE the write that
 * fills it, not after the write succeeds: a write failure partway through a
 * batch (disk full, permissions) must not leak the file that failed, or the
 * ones written before it. Bundling create+write into one `writeFile` call
 * keeps this simple while preserving that guarantee — whichever step inside
 * it fails, the path was already registered for cleanup first.
 */
export async function withAttachmentsManifest<T>(
  attachments: PreparedAttachment[],
  run: (manifestPath: string | undefined) => Promise<T>,
  writeFile: AttachmentFileWriter = defaultWriteAttachmentFile,
): Promise<T> {
  if (attachments.length === 0) {
    return run(undefined);
  }

  const tempPaths: string[] = [];
  try {
    const manifestEntries: Array<{ path: string; name: string }> = [];
    for (const attachment of attachments) {
      const tempPath = path.join(os.tmpdir(), `cloudcli-bugreport-attachment-${randomUUID()}`);
      tempPaths.push(tempPath); // tracked for cleanup BEFORE the write, not after it succeeds
      await writeFile(tempPath, attachment.bytes);
      manifestEntries.push({ path: tempPath, name: attachment.name });
    }

    const manifestPath = path.join(os.tmpdir(), `cloudcli-bugreport-manifest-${randomUUID()}.json`);
    tempPaths.push(manifestPath);
    await writeFile(manifestPath, Buffer.from(JSON.stringify(manifestEntries), 'utf8'));

    return await run(manifestPath);
  } finally {
    await Promise.allSettled(tempPaths.map((tempPath) => rm(tempPath, { force: true })));
  }
}
