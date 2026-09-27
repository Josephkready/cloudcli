// Pure request-parsing helpers for the provider routes' JSON request bodies.
//
// These validate `req.body` payloads at the HTTP boundary and throw `AppError`
// (HTTP 400) on bad input. They live here — away from `provider.routes.ts`,
// which pulls in the whole service graph on import — so they can be unit-tested
// directly against their edge cases without booting the server. See
// `provider.body.parsers.test.ts`. Part of the `*.parsers.ts` family (see
// `provider.routes.parsers.ts`, `provider.path-params.parsers.ts`).

import type { McpScope, ProviderChangeActiveModelInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import { readOptionalQueryString } from '@/modules/providers/provider.routes.parsers.js';

/**
 * Parse an optional MCP `scope`. Absent/empty reads as `undefined`; a present
 * value must be one of `user`/`local`/`project` or it throws a 400.
 */
export const parseMcpScope = (value: unknown): McpScope | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'user' || normalized === 'local' || normalized === 'project') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP scope "${normalized}".`, {
    code: 'INVALID_MCP_SCOPE',
    statusCode: 400,
  });
};

/**
 * Parse the `PUT .../sessions/:sessionId` rename body. Requires an object with
 * a non-empty `summary` string; trims it and rejects summaries longer than 500
 * characters with a 400.
 */
export const parseSessionRenameSummary = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  if (!summary) {
    throw new AppError('Summary is required.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  if (summary.length > 500) {
    throw new AppError('Summary must not exceed 500 characters.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  return summary;
};

/**
 * Parse the `POST .../active-model` body. Requires an object with a non-empty
 * `model` string. The `sessionId` is filled in by the caller from the path
 * param, so it is returned as an empty placeholder here.
 */
export const parseChangeActiveModelPayload = (payload: unknown): ProviderChangeActiveModelInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const model = readOptionalQueryString(body.model);
  if (!model) {
    throw new AppError('model is required.', {
      code: 'MODEL_REQUIRED',
      statusCode: 400,
    });
  }

  return {
    sessionId: '',
    model,
  };
};
