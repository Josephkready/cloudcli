/**
 * In-app bug reporter (#top-panel bug button).
 *
 * The authenticated web process inserts the prepared issue into the host-local
 * durable queue and returns as soon as SQLite owns it. A separate worker owns
 * GitHub credentials, rate limits, retries, and ambiguous-create reconciliation.
 */

import { spawn } from 'node:child_process';

import express from 'express';

import {
  buildIssueBody,
  buildIssueTitle,
  describeDescriptionRejection,
  normalizeDescription,
  resolveBugReportRepo,
  type BugReportMetadata,
} from '@/shared/bug-report.js';
import { AppError, asyncHandler, createApiSuccessResponse, readObjectRecord } from '@/shared/utils.js';

const DEFAULT_QUEUE_TIMEOUT_MS = 5000;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_QUEUE_STATUSES = new Set(['pending', 'retry', 'filing', 'filed', 'uncertain', 'failed']);

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

async function queueCommand(
  run: QueueRunner,
  args: string[],
  input = '',
): Promise<Record<string, unknown>> {
  const result = await run(args, input);
  let payload: Record<string, unknown> | null = null;
  try {
    payload = parseQueuePayload(result.stdout);
  } catch (error) {
    if (result.code === 0) throw error;
  }

  if (result.code !== 0 || payload?.status === 'error') {
    // The queue's public error detail is body/title-free by contract. Do not log stderr or argv.
    const detail = typeof payload?.detail === 'string' ? payload.detail.slice(0, 400) : '';
    console.error('Bug report issue-queue command failed:', result.code, detail);
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
      const body = readObjectRecord(req.body) ?? {};
      const description = normalizeDescription(body.description);

      if (!description) {
        throw new AppError(describeDescriptionRejection(body.description), {
          code: 'BUG_REPORT_DESCRIPTION_REQUIRED',
          statusCode: 400,
        });
      }

      const clientMetadata = (readObjectRecord(body.metadata) ?? {}) as BugReportMetadata;
      const metadata: BugReportMetadata = {
        ...clientMetadata,
        platform: `${process.platform} ${process.arch}`,
        nodeVersion: process.version,
        reportedAt: new Date().toISOString(),
      };

      const repo = resolveBugReportRepo();
      const title = buildIssueTitle(description);
      const issueBody = buildIssueBody(description, metadata);
      const payload = await queueCommand(run, [
        'enqueue', '--repo', repo, '--title', title, '--label', 'bug', '--body-file', '-',
      ], issueBody);
      const id = payload.id;

      if (payload.status !== 'queued' || !validJobId(id)) {
        throw queueProtocolError();
      }

      console.info('Bug report queued:', id, repo);
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
        throw queueProtocolError();
      }
      res.json(createApiSuccessResponse(payload));
    }),
  );

  return router;
}

export default createBugReportRouter();
