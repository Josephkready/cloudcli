// Build-time asset precompression (issue #266).
//
// A cold load of the SPA used to ship ~3.6 MB because the server sent every
// bundle uncompressed. Rather than pay gzip CPU on every request for files that
// never change between builds, `npm run build:client` compresses each text asset
// once and writes `<asset>.br` / `<asset>.gz` next to it. At request time
// server/middleware/compression.ts serves the sibling directly, so the runtime
// cost of compression is exactly zero and brotli can afford its slowest,
// smallest setting.
//
// Deliberately NOT precompressed:
//   - index.html — server/index.js rewrites it per request to inject
//     `window.__ROUTER_BASENAME__`, so a build-time variant would ship stale
//     HTML for reverse-proxy deployments. It is small and the runtime
//     `compression()` fallback handles it.
//   - already-compressed binaries (woff2, png, ...) — compressing them again
//     costs bytes rather than saving them.
//
// Run directly to compress a directory:
//   tsx --tsconfig server/tsconfig.json server/shared/precompress-assets.ts dist

import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const brotliCompressAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);

/**
 * Extensions worth compressing. Kept as the single source of truth for both the
 * build step and the request-time middleware so a file can never be precompressed
 * without also being served with `Vary: Accept-Encoding`.
 *
 * `.html` is intentionally absent — see the module comment.
 */
export const PRECOMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
    '.js',
    '.mjs',
    '.cjs',
    '.css',
    '.json',
    '.map',
    '.svg',
    '.txt',
    '.xml',
    '.webmanifest',
]);

/** Request-time encoding token -> the file suffix its variant is stored under. */
export const ENCODING_FILE_SUFFIXES = {
    br: '.br',
    gzip: '.gz',
} as const;

export type PrecompressedEncoding = keyof typeof ENCODING_FILE_SUFFIXES;

/**
 * Files smaller than this are skipped: below roughly one TCP segment the
 * framing overhead cancels out the savings, and it matches the default
 * threshold of the runtime `compression()` fallback.
 */
export const MIN_PRECOMPRESS_BYTES = 1024;

/**
 * Brotli quality. 11 is the smallest (and slowest) setting; it is affordable
 * here because it runs once per build, not once per request. Override with
 * PRECOMPRESS_BROTLI_QUALITY when a faster build matters more than a few KB.
 */
const DEFAULT_BROTLI_QUALITY = 11;

export interface PrecompressSummary {
    /** Files walked in the target directory. */
    scanned: number;
    /** Files that got at least one variant written. */
    compressed: number;
    /** Total size of the compressed originals. */
    originalBytes: number;
    /** Total size of the emitted `.br` variants. */
    brotliBytes: number;
    /** Total size of the emitted `.gz` variants. */
    gzipBytes: number;
}

export interface PrecompressOptions {
    /** Minimum original size, in bytes, worth compressing. */
    minBytes?: number;
    /** Brotli quality, 0-11. */
    brotliQuality?: number;
}

async function collectFiles(dir: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectFiles(full)));
        } else if (entry.isFile()) {
            files.push(full);
        }
    }
    return files;
}

/** True when `filePath` is a text asset the SPA serves and a compressed sibling would help. */
function isPrecompressible(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (!PRECOMPRESSIBLE_EXTENSIONS.has(ext)) {
        return false;
    }
    // Never compress a compressed sibling from a previous run.
    return !Object.values(ENCODING_FILE_SUFFIXES).some((suffix) => filePath.endsWith(suffix));
}

async function readFileBuffer(filePath: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(filePath)) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

/**
 * Compress every eligible file under `dir` in place, writing `<file>.br` and
 * `<file>.gz` siblings. A variant is only kept when it is actually smaller than
 * the original, so the request-time middleware can trust that a sibling means
 * "fewer bytes on the wire".
 */
export async function precompressDirectory(
    dir: string,
    options: PrecompressOptions = {},
): Promise<PrecompressSummary> {
    const minBytes = options.minBytes ?? MIN_PRECOMPRESS_BYTES;
    const envQuality = Number.parseInt(process.env.PRECOMPRESS_BROTLI_QUALITY || '', 10);
    const brotliQuality = options.brotliQuality
        ?? (Number.isFinite(envQuality) ? envQuality : DEFAULT_BROTLI_QUALITY);

    const files = await collectFiles(dir);
    const summary: PrecompressSummary = {
        scanned: files.length,
        compressed: 0,
        originalBytes: 0,
        brotliBytes: 0,
        gzipBytes: 0,
    };

    const candidates: string[] = [];
    for (const file of files) {
        if (!isPrecompressible(file)) {
            continue;
        }
        const stats = await stat(file);
        if (stats.size < minBytes) {
            continue;
        }
        candidates.push(file);
    }

    // zlib's async API runs on libuv's thread pool, so compressing the bundles
    // concurrently keeps brotli quality 11 off the build's critical path.
    const results = await Promise.all(
        candidates.map(async (file) => {
            const source = await readFileBuffer(file);
            const [brotli, gzipped] = await Promise.all([
                brotliCompressAsync(source, {
                    params: {
                        [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length,
                    },
                }),
                gzipAsync(source, { level: zlib.constants.Z_BEST_COMPRESSION }),
            ]);

            let brotliBytes = 0;
            let gzipBytes = 0;
            if (brotli.length < source.length) {
                await writeFile(`${file}${ENCODING_FILE_SUFFIXES.br}`, brotli);
                brotliBytes = brotli.length;
            }
            if (gzipped.length < source.length) {
                await writeFile(`${file}${ENCODING_FILE_SUFFIXES.gzip}`, gzipped);
                gzipBytes = gzipped.length;
            }
            return { originalBytes: source.length, brotliBytes, gzipBytes };
        }),
    );

    for (const result of results) {
        if (result.brotliBytes === 0 && result.gzipBytes === 0) {
            continue;
        }
        summary.compressed += 1;
        summary.originalBytes += result.originalBytes;
        summary.brotliBytes += result.brotliBytes;
        summary.gzipBytes += result.gzipBytes;
    }

    return summary;
}

function formatKb(bytes: number): string {
    return `${(bytes / 1024).toFixed(1)} KB`;
}

/** CLI entry point used by `npm run build:client`. */
async function main(): Promise<void> {
    const target = path.resolve(process.argv[2] || 'dist');
    const started = Date.now();
    const summary = await precompressDirectory(target);
    if (summary.compressed === 0) {
        console.log(`precompress: nothing to compress in ${target}`);
        return;
    }
    console.log(
        `precompress: ${summary.compressed} files, ${formatKb(summary.originalBytes)} -> `
        + `${formatKb(summary.brotliBytes)} br / ${formatKb(summary.gzipBytes)} gzip `
        + `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
    main().catch((error) => {
        console.error('precompress: failed', error);
        process.exitCode = 1;
    });
}
