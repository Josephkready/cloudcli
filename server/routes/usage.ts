/**
 * Feature-usage ingest (issue #248).
 *
 * A single write endpoint. There is deliberately no read or clear endpoint: the
 * readout is the `cloudcli usage` CLI subcommand, so a project trying to shed UI
 * surface does not grow a dashboard to look at its own counters.
 */

import express, { type Request, type Response } from 'express';

import { featureUsageDb } from '@/modules/database/index.js';

const router = express.Router();

/**
 * Records a batch of feature hits.
 *
 * Always answers 200 with the current `enabled` state, even when nothing was
 * stored: the client latches recording off when it sees `enabled: false`, which
 * is what makes the `FEATURE_USAGE_ENABLED` off switch stop the traffic and not
 * just the writes. Never 5xx — a failed counter must not surface to the user as
 * a broken action.
 */
router.post('/', (req: Request, res: Response) => {
  const enabled = featureUsageDb.isEnabled();
  const keys: unknown = (req.body as { keys?: unknown } | undefined)?.keys;
  const recorded = Array.isArray(keys) ? featureUsageDb.recordFeatureUses(keys) : 0;

  res.json({ enabled, recorded });
});

export default router;
