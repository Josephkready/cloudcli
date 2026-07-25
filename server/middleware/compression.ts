// HTTP response compression (issue #266).
//
// Two layers, in this order:
//
//   1. `createCompressionMiddleware()` — the generic `compression()` fallback,
//      mounted before the API routes so dynamic JSON, index.html, and anything
//      served out of public/ get gzip/brotli on the fly.
//   2. `createPrecompressedAssets()` — mounted just before the dist/ static
//      handler. When the build has already emitted `<asset>.br` / `<asset>.gz`
//      (see server/shared/precompress-assets.ts) this rewrites the request at
//      the variant, so hashed bundles cost zero compression CPU per request and
//      get brotli quality 11 instead of the cheap streaming setting.
//
// Layer 2 sets `Content-Encoding` before layer 1 inspects the response, so a
// precompressed hit is never double-compressed.

import fs from 'node:fs';
import path from 'node:path';

import compression from 'compression';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import mime from 'mime-types';

import {
    ENCODING_FILE_SUFFIXES,
    PRECOMPRESSIBLE_EXTENSIONS,
    type PrecompressedEncoding,
} from '../shared/precompress-assets.js';

/** File suffix (`.br`) -> the `Content-Encoding` token it must be served with. */
const SUFFIX_ENCODINGS = new Map<string, PrecompressedEncoding>(
    (Object.entries(ENCODING_FILE_SUFFIXES) as [PrecompressedEncoding, string][])
        .map(([encoding, suffix]) => [suffix, encoding]),
);

/** Assets that get a one-year immutable cache because their names are content-hashed. */
const IMMUTABLE_ASSET_PATTERN = /\.(js|mjs|cjs|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico|webp|avif)$/i;

/**
 * Web fonts, which are the only thing under `public/` safe to freeze in a cache.
 *
 * Unlike `dist/assets`, `public/` filenames are author-controlled and stable, so
 * a blanket immutable policy there would pin `sw.js` and the logos for a year.
 * The self-hosted font files (issue #270) are the exception: they are versioned
 * in their filename (`encode-sans-v23-latin.woff2`), so refreshing a family
 * changes the URL and a frozen cache entry can never go stale.
 */
const PUBLIC_IMMUTABLE_PATTERN = /\.(woff2?|ttf|otf|eot)$/i;

/** Parse an `Accept-Encoding` header into encoding token -> quality value. */
function parseAcceptEncoding(header: string | string[] | undefined): Map<string, number> {
    const qualities = new Map<string, number>();
    if (!header) {
        return qualities;
    }

    const raw = Array.isArray(header) ? header.join(',') : header;
    for (const part of raw.split(',')) {
        const [tokenPart, ...params] = part.split(';');
        const token = tokenPart.trim().toLowerCase();
        if (!token) {
            continue;
        }
        let quality = 1;
        for (const param of params) {
            const match = /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(param);
            if (match) {
                const parsed = Number.parseFloat(match[1]);
                if (Number.isFinite(parsed)) {
                    quality = parsed;
                }
            }
        }
        qualities.set(token, quality);
    }
    return qualities;
}

function qualityOf(qualities: Map<string, number>, token: string): number {
    const explicit = qualities.get(token);
    if (explicit !== undefined) {
        return explicit;
    }
    return qualities.get('*') ?? 0;
}

/**
 * Choose which precompressed variant to serve, or null when the client wants
 * none. Brotli wins ties because its build-time output is meaningfully smaller
 * than gzip on JS.
 */
export function pickPrecompressedEncoding(
    acceptEncoding: string | string[] | undefined,
): PrecompressedEncoding | null {
    const qualities = parseAcceptEncoding(acceptEncoding);
    if (qualities.size === 0) {
        return null;
    }

    const brotli = qualityOf(qualities, 'br');
    const gzip = qualityOf(qualities, 'gzip');
    if (brotli > 0 && brotli >= gzip) {
        return 'br';
    }
    if (gzip > 0) {
        return 'gzip';
    }
    return null;
}

/**
 * `compression()`'s filter, plus the exclusions this app needs.
 *
 * The default filter already skips already-compressed media types (woff2, png,
 * ...) via `compressible`. On top of that:
 *   - `text/event-stream` must stay uncompressed or the streaming chat/agent
 *     endpoints would buffer frames until the compressor flushes.
 *   - a response that already carries `Content-Encoding` is a precompressed
 *     static hit and must not be re-encoded.
 */
export function shouldCompressResponse(req: Request, res: Response): boolean {
    const contentType = res.getHeader('Content-Type');
    const type = Array.isArray(contentType) ? contentType[0] : contentType;
    if (typeof type === 'string' && type.toLowerCase().includes('text/event-stream')) {
        return false;
    }
    if (res.getHeader('Content-Encoding')) {
        return false;
    }
    return compression.filter(req, res);
}

/** Generic on-the-fly compression for dynamic responses. */
export function createCompressionMiddleware(): RequestHandler {
    return compression({ filter: shouldCompressResponse });
}

/**
 * Serve `<asset>.br` / `<asset>.gz` when the build produced one and the client
 * accepts it, by rewriting `req.url` so the downstream `express.static` handler
 * still does the actual sending (ETag, ranges, conditional GETs all keep
 * working, keyed on the variant that is really on the wire).
 */
export function createPrecompressedAssets({ root }: { root: string }): RequestHandler {
    const resolvedRoot = path.resolve(root);

    return function precompressedAssets(req: Request, res: Response, next: NextFunction): void {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            next();
            return;
        }

        const encoding = pickPrecompressedEncoding(req.headers['accept-encoding']);
        if (!encoding) {
            next();
            return;
        }

        const queryAt = req.url.indexOf('?');
        const pathname = queryAt === -1 ? req.url : req.url.slice(0, queryAt);
        const suffixedQuery = queryAt === -1 ? '' : req.url.slice(queryAt);

        let decoded: string;
        try {
            decoded = decodeURIComponent(pathname);
        } catch {
            next();
            return;
        }

        if (!PRECOMPRESSIBLE_EXTENSIONS.has(path.extname(decoded).toLowerCase())) {
            next();
            return;
        }

        // path.join normalises `..`; anything that escapes the asset root is
        // left for express.static to reject.
        const assetPath = path.join(resolvedRoot, decoded);
        if (assetPath !== resolvedRoot && !assetPath.startsWith(resolvedRoot + path.sep)) {
            next();
            return;
        }

        const suffix = ENCODING_FILE_SUFFIXES[encoding];
        try {
            if (!fs.statSync(`${assetPath}${suffix}`).isFile()) {
                next();
                return;
            }
        } catch {
            next();
            return;
        }

        req.url = `${pathname}${suffix}${suffixedQuery}`;
        next();
    };
}

/**
 * `setHeaders` hook for the dist/ static handler.
 *
 * Runs before `send` picks a Content-Type, which is what lets a `.js.br` file
 * be labelled as JavaScript rather than as an unknown binary. Also owns the
 * cache policy: hashed assets are immutable for a year, HTML never caches.
 */
export function setStaticAssetHeaders(res: Response, filePath: string): void {
    let assetPath = filePath;

    const suffix = path.extname(filePath).toLowerCase();
    const encoding = SUFFIX_ENCODINGS.get(suffix);
    if (encoding) {
        assetPath = filePath.slice(0, -suffix.length);
        res.setHeader('Content-Encoding', encoding);
        const contentType = mime.contentType(path.basename(assetPath));
        if (contentType) {
            res.setHeader('Content-Type', contentType);
        }
    }

    // Any asset that *could* have been served compressed needs Vary, including
    // the identity response, so a shared cache never hands a gzip-only client a
    // brotli body (or vice versa). Assets we never compress skip it, to keep
    // their cache keys single-variant.
    if (PRECOMPRESSIBLE_EXTENSIONS.has(path.extname(assetPath).toLowerCase())) {
        res.setHeader('Vary', 'Accept-Encoding');
    }

    if (assetPath.endsWith('.html')) {
        // Prevent HTML caching to avoid service worker issues after builds
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    } else if (IMMUTABLE_ASSET_PATTERN.test(assetPath)) {
        // Cache static assets for 1 year (they have hashed names)
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
}

/**
 * `setHeaders` hook for the `public/` static handler.
 *
 * That handler is mounted *before* the dist/ one, so it — not
 * `setStaticAssetHeaders` — is what actually answers `/fonts/*.woff2` even
 * though vite also copies the fonts into `dist/`. Without this the self-hosted
 * fonts (issue #270) would revalidate on every cold load, which is most of the
 * latency self-hosting was supposed to remove.
 *
 * Deliberately narrower than `setStaticAssetHeaders`: only fonts are frozen.
 * `public/` also holds `sw.js`, `manifest.json` and the logos, and freezing the
 * service worker for a year would strand clients on a dead build.
 */
export function setPublicAssetHeaders(res: Response, filePath: string): void {
    if (PUBLIC_IMMUTABLE_PATTERN.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
}
