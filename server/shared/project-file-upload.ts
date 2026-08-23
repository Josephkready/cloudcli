import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { validateProjectPath } from './utils.js';

export type TemporaryUploadFile = {
  originalname: string;
  path: string;
  size: number;
  mimetype: string;
};

export type UploadedProjectFile = {
  name: string;
  path: string;
  size: number;
  mimeType: string;
};

type ProjectUploadResult =
  | { ok: true; files: UploadedProjectFile[] }
  | { ok: false; rejectedFiles: string[] };

export async function cleanupUploadedTempFiles(
  files: TemporaryUploadFile[] | undefined,
  context: string,
): Promise<void> {
  if (!files || files.length === 0) return;

  const results = await Promise.allSettled(files.map(async (file) => {
    try {
      await fsPromises.unlink(file.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }));
  const failedFileCount = results.filter((result) => result.status === 'rejected').length;
  if (failedFileCount > 0) {
    console.warn('Failed to clean up temporary upload files', { context, failedFileCount });
  }
}

export async function processProjectUpload({
  projectRoot,
  resolvedTargetDir,
  files,
  relativePaths,
}: {
  projectRoot: string;
  resolvedTargetDir: string;
  files: TemporaryUploadFile[];
  relativePaths: unknown[];
}): Promise<ProjectUploadResult> {
  const uploadPlans: Array<{
    file: TemporaryUploadFile;
    fileName: string;
    destination: string;
  }> = [];
  const rejectedFiles: string[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const relativePath = relativePaths[index];
    const fileName = typeof relativePath === 'string' && relativePath.length > 0
      ? relativePath
      : file.originalname;
    const validation = await validateProjectPath(
      projectRoot,
      path.join(resolvedTargetDir, fileName),
    );
    if (!validation.valid || !validation.resolved) {
      rejectedFiles.push(fileName);
      continue;
    }
    uploadPlans.push({ file, fileName, destination: validation.resolved });
  }

  if (rejectedFiles.length > 0) {
    await cleanupUploadedTempFiles(files, 'rejected upload batch');
    return { ok: false, rejectedFiles };
  }

  await fsPromises.mkdir(resolvedTargetDir, { recursive: true });
  const uploadedFiles: UploadedProjectFile[] = [];
  for (const { file, fileName, destination } of uploadPlans) {
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    await fsPromises.copyFile(file.path, destination);
    await fsPromises.unlink(file.path);
    uploadedFiles.push({
      name: fileName,
      path: destination,
      size: file.size,
      mimeType: file.mimetype,
    });
  }

  return { ok: true, files: uploadedFiles };
}
