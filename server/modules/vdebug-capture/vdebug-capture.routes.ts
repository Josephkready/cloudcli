/**
 * video-debugger Phase 1 wiring: the recorder-script gate and the ingest endpoint.
 *
 * Mounted by server/index.js AHEAD of the global `express.json` (50 MB) so this
 * endpoint gets its own small body cap, and ahead of `validateApiKey`: the
 * recorder is a plain `fetch`/`sendBeacon` with no credentials, exactly like
 * the upstream template's unauthenticated endpoint. The app is LAN/tailnet-only,
 * and the endpoint can only ever append allowlisted intent events.
 *
 * The contract with the rest of the app is "capture never breaks anything":
 *   - every storage failure is caught and logged (rate-limited), never thrown;
 *   - `VD_CAPTURE_ENABLED=false` turns it off without a deploy: the recorder
 *     URL then serves a no-op script and the endpoint stores nothing;
 *   - the recorder itself swallows network errors and never surfaces them.
 *
 * Config (all optional):
 *   VD_CAPTURE_ENABLED         default on; `false`/`0`/`off`/`no` disables
 *   VD_FLOWS_DB                default `<dir of DATABASE_PATH>/flows.db`
 *                              (prod: /var/lib/cloudcli/flows.db — a state path)
 *   VD_CAPTURE_RETENTION_DAYS  default 30; sessions older than this are pruned
 *                              at startup and daily, so no host timer is needed
 */

import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { BatchError, FlowStore } from './flow-store.js';

export const VD_EVENTS_PATH = '/api/_vd/events';
export const VD_RECORDER_PATH = '/vd-recorder.js';
export const MAX_BODY_BYTES = 256_000;
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const REOPEN_BACKOFF_MS = 60_000;
/** Recorder flushes every 5 s (~12 batches/min/tab); this is far above any real use. */
const DEFAULT_MAX_BATCHES_PER_MINUTE = 300;

export type VdebugCaptureConfig = {
  enabled: boolean;
  dbPath: string;
  retentionDays: number;
  maxBatchesPerMinute: number;
};

export function resolveVdebugCaptureConfig(env: NodeJS.ProcessEnv = process.env): VdebugCaptureConfig {
  const flag = (env.VD_CAPTURE_ENABLED ?? '').trim().toLowerCase();
  const enabled = !['false', '0', 'off', 'no'].includes(flag);
  const authDb = env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli', 'auth.db');
  const dbPath = env.VD_FLOWS_DB?.trim() || path.join(path.dirname(authDb), 'flows.db');
  const days = Number.parseInt(env.VD_CAPTURE_RETENTION_DAYS ?? '', 10);
  return {
    enabled,
    dbPath,
    retentionDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS,
    maxBatchesPerMinute: DEFAULT_MAX_BATCHES_PER_MINUTE,
  };
}

type Logger = Pick<Console, 'warn'> & Partial<Pick<Console, 'info'>>;

export function createVdebugCaptureRouter(
  config: VdebugCaptureConfig,
  options: { logger?: Logger; now?: () => number } = {},
): express.Router {
  const logger = options.logger ?? console;
  const now = options.now ?? Date.now;
  const router = express.Router();

  let store: FlowStore | null = null;
  let openFailedAt = -Infinity;
  let lastPruneAt = -Infinity;
  let lastWarnAt = -Infinity;
  let windowStart = 0;
  let windowCount = 0;

  const warn = (message: string) => {
    // At most one line a minute: a broken disk must not flood the journal.
    if (now() - lastWarnAt >= 60_000) {
      lastWarnAt = now();
      logger.warn(`[vd-capture] ${message}`);
    }
  };

  const getStore = (): FlowStore | null => {
    if (store) return store;
    if (now() - openFailedAt < REOPEN_BACKOFF_MS) return null;
    try {
      store = new FlowStore(config.dbPath);
    } catch (error) {
      openFailedAt = now();
      warn(`cannot open ${config.dbPath}: ${(error as Error).message} (capture paused, app unaffected)`);
      return null;
    }
    return store;
  };

  const maybePrune = (s: FlowStore) => {
    if (now() - lastPruneAt < DAY_MS) return;
    lastPruneAt = now();
    try {
      s.prune(config.retentionDays);
    } catch (error) {
      warn(`prune failed: ${(error as Error).message}`);
    }
  };

  router.get(VD_RECORDER_PATH, (_req, res, next) => {
    if (config.enabled) return next(); // the static handler serves public/vd-recorder.js
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send('/* video-debugger capture disabled (VD_CAPTURE_ENABLED) */\n');
  });

  router.post(
    VD_EVENTS_PATH,
    // `type: () => true` — sendBeacon may arrive as text/plain on some browsers.
    express.json({ limit: MAX_BODY_BYTES, type: () => true, strict: true }),
    (req, res) => {
      if (!config.enabled) return res.status(204).end();

      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        windowCount = 0;
      }
      windowCount += 1;
      if (windowCount > config.maxBatchesPerMinute) {
        if (windowCount === config.maxBatchesPerMinute + 1) {
          warn(`rate limit hit (${config.maxBatchesPerMinute} batches/min); answering 429`);
        }
        return res.status(429).end();
      }

      const s = getStore();
      if (!s) return res.status(503).end();
      try {
        const result = s.ingest(req.body, { userAgent: req.get('user-agent') });
        if (result.invalid || result.capped) {
          warn(`dropped ${result.invalid} invalid event(s), capped=${result.capped}`);
        }
      } catch (error) {
        if (error instanceof BatchError) return res.status(400).end();
        warn(`ingest failed: ${(error as Error).message}`);
        return res.status(503).end();
      }
      maybePrune(s);
      return res.status(204).end();
    },
  );

  // Body-parser failures on this route only (oversize / malformed JSON): answer
  // with a bare status, never the global error page, and never a 5xx.
  router.use(VD_EVENTS_PATH, ((error, _req, res, next) => {
    if (!error) return next();
    const status = (error as { type?: string }).type === 'entity.too.large' ? 413 : 400;
    return res.status(status).end();
  }) as express.ErrorRequestHandler);

  // Startup prune, off the request path; never blocks boot or throws.
  if (config.enabled) {
    logger.info?.(`[vd-capture] enabled: db=${config.dbPath}, retention=${config.retentionDays}d`);
    setImmediate(() => {
      const s = getStore();
      if (s) maybePrune(s);
    }).unref?.();
  }

  return router;
}
