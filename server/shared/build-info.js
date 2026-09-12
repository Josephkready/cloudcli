import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Router } from 'express';

/**
 * Build identity the dante deploy stamps at build time (#458).
 *
 * scripts/dante-build.sh writes dist/build-info.json (`{sha, built_at}`) and the server
 * reads it once at startup, mirroring how RUNNING_VERSION captures package.json. The same
 * SHA is inlined into the client bundle by vite.config.js, so /health can report a
 * per-deploy identity that actually changes — this fork ships by ansible-pull with no
 * version bumps, so semver alone could never tell an open tab a new build landed.
 */

/** Parses dist/build-info.json under `appRoot`, or returns null when absent/invalid. */
export const readBuildInfo = (appRoot, fs = readFileSync) => {
    try {
        const raw = fs(path.join(appRoot, 'dist', 'build-info.json'), 'utf8');
        const parsed = JSON.parse(raw);
        const sha = typeof parsed?.sha === 'string' && parsed.sha.trim() ? parsed.sha.trim() : null;
        const builtAt = typeof parsed?.built_at === 'string' && parsed.built_at.trim() ? parsed.built_at.trim() : null;
        if (!sha && !builtAt) return null;
        return { sha, built_at: builtAt };
    } catch {
        return null;
    }
};

/**
 * The /health payload. `build` is included only when present, so a pre-#458 server or a
 * plain `npm run build` (no build-info.json) keeps the old response shape and clients
 * fall back to the semver comparison.
 */
export const buildHealthPayload = ({ status = 'ok', timestamp, installMode, version, build }) => {
    const payload = { status, timestamp, installMode, version };
    if (build) payload.build = build;
    return payload;
};

/** Express router mounting GET /health with build identity. */
export const createHealthRouter = ({ installMode, version, build }) => {
    const router = Router();
    router.get('/health', (req, res) => {
        res.json(buildHealthPayload({
            status: 'ok',
            timestamp: new Date().toISOString(),
            installMode,
            version,
            build,
        }));
    });
    return router;
};
