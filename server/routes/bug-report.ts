/**
 * In-app bug reporter (#top-panel bug button).
 *
 * Takes the user's written report plus the session metadata the client collects
 * and files it as a GitHub issue using the `gh` CLI already authenticated on the
 * host. There is no token handling here on purpose: the server borrows whatever
 * identity `gh auth` is logged in as, and reports a clear error when it isn't.
 */

import { spawn } from 'node:child_process';

import express from 'express';

import {
  buildIssueBody,
  buildIssueTitle,
  normalizeDescription,
  parseIssueUrl,
  resolveBugReportRepo,
  MAX_DESCRIPTION_LENGTH,
  type BugReportMetadata,
} from '@/shared/bug-report.js';
import { AppError, asyncHandler, createApiSuccessResponse, readObjectRecord } from '@/shared/utils.js';

const router = express.Router();

/** `gh` occasionally hangs on a stale auth prompt; don't hold the request open forever. */
const GH_TIMEOUT_MS = 30000;

type GhResult = { code: number | null; stdout: string; stderr: string };

/**
 * Runs `gh` with the given args, never through a shell.
 *
 * Arguments are passed as an argv array so a description containing shell
 * metacharacters is inert.
 */
export function runGh(
  args: string[],
  timeoutMs: number = GH_TIMEOUT_MS,
): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new AppError('Timed out talking to GitHub. Please try again.', {
        code: 'BUG_REPORT_GH_TIMEOUT',
        statusCode: 504,
      }));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (error.code === 'ENOENT') {
        reject(new AppError(
          'The GitHub CLI (`gh`) is not installed on the server, so the report could not be filed.',
          { code: 'BUG_REPORT_GH_MISSING', statusCode: 503 },
        ));
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Maps a failed `gh issue create` into a message the user can act on.
 *
 * The raw stderr is not returned to the client: it can carry host paths and
 * token hints, and it rarely says anything a reporter can use.
 */
function describeGhFailure(stderr: string): AppError {
  const text = stderr.toLowerCase();

  if (text.includes('not logged into') || text.includes('gh auth login') || text.includes('authentication')) {
    return new AppError(
      'The server\'s GitHub CLI is not authenticated, so the report could not be filed. Run `gh auth login` on the server.',
      { code: 'BUG_REPORT_GH_UNAUTHENTICATED', statusCode: 503 },
    );
  }

  if (text.includes('could not resolve to a repository') || text.includes('not found')) {
    return new AppError(
      'The configured bug-report repository could not be found on GitHub.',
      { code: 'BUG_REPORT_REPO_NOT_FOUND', statusCode: 502 },
    );
  }

  if (text.includes('issues are disabled') || text.includes('has disabled issues')) {
    return new AppError(
      'Issues are disabled on the configured bug-report repository.',
      { code: 'BUG_REPORT_ISSUES_DISABLED', statusCode: 502 },
    );
  }

  return new AppError('GitHub rejected the report. Please try again later.', {
    code: 'BUG_REPORT_GH_FAILED',
    statusCode: 502,
  });
}

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = readObjectRecord(req.body) ?? {};
    const description = normalizeDescription(body.description);

    if (!description) {
      throw new AppError(
        `Please describe the bug (up to ${MAX_DESCRIPTION_LENGTH} characters).`,
        { code: 'BUG_REPORT_DESCRIPTION_REQUIRED', statusCode: 400 },
      );
    }

    const clientMetadata = (readObjectRecord(body.metadata) ?? {}) as BugReportMetadata;
    // Server-side facts win over anything the client claims about the host.
    const metadata: BugReportMetadata = {
      ...clientMetadata,
      platform: `${process.platform} ${process.arch}`,
      nodeVersion: process.version,
      reportedAt: new Date().toISOString(),
    };

    const repo = resolveBugReportRepo();
    const title = buildIssueTitle(description);
    const issueBody = buildIssueBody(description, metadata);

    const result = await runGh([
      'issue', 'create',
      '--repo', repo,
      '--title', title,
      '--body', issueBody,
    ]);

    if (result.code !== 0) {
      throw describeGhFailure(result.stderr);
    }

    const issueUrl = parseIssueUrl(result.stdout);
    if (!issueUrl) {
      throw new AppError('The issue was filed but GitHub did not return a link to it.', {
        code: 'BUG_REPORT_NO_URL',
        statusCode: 502,
      });
    }

    res.json(createApiSuccessResponse({ issueUrl, repo }));
  }),
);

export default router;
