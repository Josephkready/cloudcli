/**
 * In-app bug reporter (#top-panel bug button).
 *
 * The authenticated web process inserts the prepared issue into the host-local
 * durable queue and returns as soon as SQLite owns it. A separate worker owns
 * GitHub credentials, rate limits, retries, and ambiguous-create reconciliation.
 *
 * Config: `BUG_REPORT_QUEUE_BIN` (default `issue-queue`),
 * `BUG_REPORT_QUEUE_TIMEOUT_MS` (positive milliseconds, default `5000`), and
 * `ISSUE_QUEUE_DB` (the SQLite path shared by this producer and the worker).
 *
 * **Screenshots** (dante-config skills/bug-report-button/SKILL.md §9) ride
 * the same POST as a `multipart/form-data` request instead of JSON — the
 * image-free case (the overwhelming common one) keeps posting plain JSON
 * completely unchanged; multipart is only ever parsed when the request
 * actually declares that content type. Attachments are re-validated here
 * independently of the client (count/size/sniffed-mime — see
 * `@/shared/bug-report-attachments.js`) and never enter the allowlisted
 * metadata object. Validated bytes travel to `issue-queue enqueue` through a
 * temp-file manifest (`@/shared/bug-report-manifest.js`), which durably
 * copies them into the queue's own storage before this handler responds.
 */

import { spawn } from 'node:child_process';

import express from 'express';
import multer from 'multer';

import {
  buildIssueBody,
  buildIssueTitle,
  describeDescriptionRejection,
  normalizeDescription,
  resolveBugReportRepo,
  type BugReportMetadata,
} from '@/shared/bug-report.js';
import {
  MAX_ATTACHMENTS,
  prepareAttachments,
  type PreparedAttachment,
} from '@/shared/bug-report-attachments.js';
import { withAttachmentsManifest } from '@/shared/bug-report-manifest.js';
import { AppError, asyncHandler, createApiSuccessResponse, readObjectRecord } from '@/shared/utils.js';

const DEFAULT_QUEUE_TIMEOUT_MS = 5000;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_QUEUE_STATUSES = new Set(['pending', 'retry', 'filing', 'filed', 'uncertain', 'failed']);

/** The minimal shape this route needs from a multer-parsed upload. */
type MulterUpload = { buffer: Buffer; originalname: string };
type RequestWithUploads = express.Request & { files?: MulterUpload[] };

/**
 * Coarse safety net against memory abuse, not the standard's real cap:
 * comfortably above the ~2MB post-compression limit `prepareAttachments`
 * enforces, so a legitimate near-cap upload always reaches that precise,
 * correctly-coded 413 rather than a generic multer rejection. Only a request
 * that is wildly over-size (a client bypassing its own compression) is
 * stopped here instead.
 */
const MULTER_FILE_SIZE_CEILING_BYTES = 8 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MULTER_FILE_SIZE_CEILING_BYTES, files: MAX_ATTACHMENTS },
});

/** Runs multer's `attachments` array parser, mapping its errors onto the app's AppError shape. */
function parseAttachmentUploads(req: express.Request, res: express.Response): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.array('attachments', MAX_ATTACHMENTS)(req, res, (error: unknown) => {
      if (!error) {
        resolve();
        return;
      }
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          reject(new AppError('An attached image was too large.', {
            code: 'BUG_REPORT_ATTACHMENT_TOO_LARGE',
            statusCode: 413,
          }));
          return;
        }
        if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
          reject(new AppError(`Up to ${MAX_ATTACHMENTS} screenshots are allowed per report.`, {
            code: 'BUG_REPORT_ATTACHMENT_COUNT',
            statusCode: 413,
          }));
          return;
        }
      }
      reject(new AppError('Could not read the uploaded screenshots.', {
        code: 'BUG_REPORT_ATTACHMENT_UPLOAD_FAILED',
        statusCode: 400,
      }));
    });
  });
}

/** Parses the `metadata` multipart field (always a string) back into an object. */
function parseMultipartMetadata(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export type QueueResult = { code: number | null; stdout: string; stderr: string };
export type QueueRunner = (args: string[], input?: string) => Promise<QueueResult>;

function configuredTimeoutMs(): number {
  const configured = Number(process.env.BUG_REPORT_QUEUE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_QUEUE_TIMEOUT_MS;
}

/** Runs one local queue command without a shell and pipes report content over stdin. */
export function runIssueQueue(
  args: string[],
  input = '',
  timeoutMs: number = configuredTimeoutMs(),
  command = process.env.BUG_REPORT_QUEUE_BIN || 'issue-queue',
): Promise<QueueResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      // Never stringify the child or args: argv includes the user-derived issue title.
      console.error(`Bug report issue-queue timed out after ${timeoutMs}ms`);
      child.kill('SIGKILL');
      reject(new AppError('Timed out saving the bug report locally. Please try again.', {
        code: 'BUG_REPORT_QUEUE_TIMEOUT',
        statusCode: 504,
      }));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      // Node's spawn error may carry spawnargs, including the report title. Log only its code.
      console.error('Bug report issue-queue spawn error:', error.code ?? error.name);
      if (error.code === 'ENOENT') {
        reject(new AppError(
          'The durable bug-report queue is not installed on the server.',
          { code: 'BUG_REPORT_QUEUE_MISSING', statusCode: 503 },
        ));
        return;
      }
      reject(new AppError('The durable bug-report queue is unavailable.', {
        code: 'BUG_REPORT_QUEUE_UNAVAILABLE',
        statusCode: 503,
      }));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    });

    child.stdin?.end(input);
  });
}

function queueProtocolError(): AppError {
  return new AppError('The durable bug-report queue returned an invalid response.', {
    code: 'BUG_REPORT_QUEUE_PROTOCOL',
    statusCode: 502,
  });
}

function parseQueuePayload(stdout: string): Record<string, unknown> {
  try {
    const payload = readObjectRecord(JSON.parse(stdout));
    if (payload) return payload;
  } catch {
    // Mapped to one stable protocol error below.
  }
  throw queueProtocolError();
}

type QueueOperation = 'enqueue' | 'status';

function logQueueFailure(
  operation: QueueOperation,
  category: 'command-error' | 'protocol-error',
  exitCode: number | null,
): void {
  // This allowlisted shape must stay free of argv, stdout/stderr, paths, titles, and bodies.
  console.error('Bug report issue-queue failure:', { operation, category, exitCode });
}

async function queueCommand(
  run: QueueRunner,
  args: string[],
  input = '',
): Promise<Record<string, unknown>> {
  const operation: QueueOperation = args[0] === 'status' ? 'status' : 'enqueue';
  const result = await run(args, input);
  let payload: Record<string, unknown> | null = null;
  try {
    payload = parseQueuePayload(result.stdout);
  } catch (error) {
    if (result.code === 0) {
      logQueueFailure(operation, 'protocol-error', result.code);
      throw error;
    }
  }

  if (result.code !== 0 || payload?.status === 'error') {
    logQueueFailure(operation, 'command-error', result.code);
    throw new AppError('The durable bug-report queue is unavailable. Please try again.', {
      code: 'BUG_REPORT_QUEUE_UNAVAILABLE',
      statusCode: 503,
    });
  }

  return payload ?? parseQueuePayload(result.stdout);
}

export function validJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value);
}

/** Builds the authenticated producer/status router. */
export function createBugReportRouter(dependencies: { runQueue?: QueueRunner } = {}) {
  const router = express.Router();
  const run = dependencies.runQueue ?? ((args: string[], input = '') => runIssueQueue(args, input));

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      // Attachments ride a multipart request; the overwhelmingly common
      // image-free case posts plain JSON and never touches multer at all.
      const isMultipart = Boolean(req.is('multipart/form-data'));
      if (isMultipart) {
        await parseAttachmentUploads(req, res);
      }

      const body = readObjectRecord(req.body) ?? {};
      const description = normalizeDescription(body.description);

      if (!description) {
        throw new AppError(describeDescriptionRejection(body.description), {
          code: 'BUG_REPORT_DESCRIPTION_REQUIRED',
          statusCode: 400,
        });
      }

      const rawMetadata = isMultipart ? parseMultipartMetadata(body.metadata) : body.metadata;
      const clientMetadata = (readObjectRecord(rawMetadata) ?? {}) as BugReportMetadata;
      const metadata: BugReportMetadata = {
        ...clientMetadata,
        platform: `${process.platform} ${process.arch}`,
        nodeVersion: process.version,
        reportedAt: new Date().toISOString(),
      };

      const uploadedFiles = (req as RequestWithUploads).files ?? [];
      const attachments: PreparedAttachment[] = uploadedFiles.length
        ? prepareAttachments(uploadedFiles.map((file) => ({
            buffer: file.buffer,
            originalname: file.originalname,
          })))
        : [];

      const repo = resolveBugReportRepo();
      const title = buildIssueTitle(description);
      const issueBody = buildIssueBody(description, metadata, { hasAttachments: attachments.length > 0 });
      const payload = await withAttachmentsManifest(attachments, (manifestPath) => {
        const args = ['enqueue', '--repo', repo, '--title', title, '--label', 'bug', '--body-file', '-'];
        if (manifestPath) args.push('--attachments-manifest', manifestPath);
        return queueCommand(run, args, issueBody);
      });
      const id = payload.id;

      if (payload.status !== 'queued' || !validJobId(id)) {
        logQueueFailure('enqueue', 'protocol-error', 0);
        throw queueProtocolError();
      }

      console.info('Bug report queued:', id, repo, 'attachments:', attachments.length);
      res.status(202).json(createApiSuccessResponse({ status: 'queued', id, repo }));
    }),
  );

  router.get(
    '/:jobId',
    asyncHandler(async (req, res) => {
      if (!validJobId(req.params.jobId)) {
        throw new AppError('Invalid bug-report queue job ID.', {
          code: 'BUG_REPORT_JOB_ID_INVALID',
          statusCode: 400,
        });
      }

      const payload = await queueCommand(run, ['status', req.params.jobId]);
      if (payload.id !== req.params.jobId || !PUBLIC_QUEUE_STATUSES.has(String(payload.status))) {
        logQueueFailure('status', 'protocol-error', 0);
        throw queueProtocolError();
      }
      res.json(createApiSuccessResponse(payload));
    }),
  );

  return router;
}

export default createBugReportRouter();
