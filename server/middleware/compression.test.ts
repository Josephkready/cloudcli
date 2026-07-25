import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import express from 'express';

import {
    MIN_PRECOMPRESS_BYTES,
    precompressDirectory,
} from '../shared/precompress-assets.js';

import {
    createCompressionMiddleware,
    createPrecompressedAssets,
    pickPrecompressedEncoding,
    setPublicAssetHeaders,
    setStaticAssetHeaders,
} from './compression.js';

const gunzip = promisify(zlib.gunzip);
const brotliDecompress = promisify(zlib.brotliDecompress);

// Deterministic, highly compressible text so the fixtures behave like real
// bundles (a few KB that gzip/brotli down to a fraction of their size).
function compressibleJs(repeats: number): string {
    return Array.from(
        { length: repeats },
        (_unused, i) => `export function handler${i}(request, response) { return response.send('ok ${i}'); }`,
    ).join('\n');
}

// Pseudo-random bytes stand in for an already-compressed binary asset (woff2 /
// png): they must not shrink, so any middleware that tried to compress them
// would be doing pure work for nothing.
function incompressibleBytes(size: number): Buffer {
    const buf = Buffer.alloc(size);
    let seed = 0x2f6e2b1;
    for (let i = 0; i < size; i += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = seed & 0xff;
    }
    return buf;
}

/** Raw HTTP GET: no automatic decompression, so headers and byte counts are exact. */
function httpGet(
    port: number,
    requestPath: string,
    headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path: requestPath, method: 'GET', headers },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body: Buffer.concat(chunks),
                    });
                });
            },
        );
        req.on('error', reject);
        req.end();
    });
}

interface Fixture {
    port: number;
    distDir: string;
    sources: Record<string, Buffer>;
}

/**
 * Build a dist/ fixture, precompress it exactly like the build does, and mount
 * the same middleware stack server/index.js mounts (compression -> precompressed
 * variants -> express.static), so these assertions are about real response
 * headers rather than a hand-rolled approximation.
 */
async function withServer(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'compression-'));
    const distDir = path.join(tempDir, 'dist');
    await mkdir(path.join(distDir, 'assets'), { recursive: true });

    const sources: Record<string, Buffer> = {
        'assets/app.js': Buffer.from(compressibleJs(400)),
        'assets/app.css': Buffer.from('.a { color: red; }\n'.repeat(300)),
        'assets/tiny.js': Buffer.from('export const a = 1;\n'),
        'assets/font.woff2': incompressibleBytes(40_000),
        'assets/pic.png': incompressibleBytes(30_000),
        'index.html': Buffer.from(`<!doctype html><html><body>${'<p>hello</p>'.repeat(200)}</body></html>`),
    };
    for (const [relative, contents] of Object.entries(sources)) {
        await writeFile(path.join(distDir, relative), contents);
    }

    await precompressDirectory(distDir);

    const app = express();
    app.use(createCompressionMiddleware());
    app.get('/api/json', (_req, res) => {
        res.json({ items: Array.from({ length: 200 }, (_unused, i) => ({ id: i, name: 'project' })) });
    });
    app.get('/api/tiny', (_req, res) => {
        res.json({ ok: true });
    });
    app.get('/api/stream', (_req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        for (let i = 0; i < 60; i += 1) {
            res.write(`data: ${JSON.stringify({ i, message: 'streaming frame padding' })}\n\n`);
        }
        res.end();
    });
    app.use(createPrecompressedAssets({ root: distDir }));
    app.use(express.static(distDir, { index: false, setHeaders: setStaticAssetHeaders }));

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
        await fn({ port, distDir, sources });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(tempDir, { recursive: true, force: true });
    }
}

test('pickPrecompressedEncoding prefers brotli, falls back to gzip, and honours q=0', () => {
    assert.equal(pickPrecompressedEncoding('gzip, deflate, br'), 'br');
    assert.equal(pickPrecompressedEncoding('gzip, deflate'), 'gzip');
    assert.equal(pickPrecompressedEncoding('br;q=0, gzip'), 'gzip');
    assert.equal(pickPrecompressedEncoding('gzip;q=0.5, br;q=0.9'), 'br');
    assert.equal(pickPrecompressedEncoding('br;q=0.2, gzip;q=0.8'), 'gzip');
    assert.equal(pickPrecompressedEncoding('identity'), null);
    assert.equal(pickPrecompressedEncoding('gzip;q=0, br;q=0'), null);
    assert.equal(pickPrecompressedEncoding(''), null);
    assert.equal(pickPrecompressedEncoding(undefined), null);
    // A bare wildcard means "anything is fine" — brotli wins.
    assert.equal(pickPrecompressedEncoding('*'), 'br');
    assert.equal(pickPrecompressedEncoding('identity;q=1, *;q=0'), null);
    assert.equal(pickPrecompressedEncoding('GZIP'), 'gzip');
});

test('JS assets are served brotli-precompressed with Vary and long-lived caching', async () => {
    await withServer(async ({ port, sources }) => {
        const response = await httpGet(port, '/assets/app.js', {
            'accept-encoding': 'gzip, deflate, br',
        });

        assert.equal(response.status, 200);
        assert.equal(response.headers['content-encoding'], 'br');
        assert.match(String(response.headers.vary), /accept-encoding/i);
        assert.match(String(response.headers['content-type']), /javascript/);
        assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');

        const decoded = await brotliDecompress(response.body);
        assert.equal(decoded.toString(), sources['assets/app.js'].toString());
        // The whole point: far fewer bytes on the wire than the raw asset.
        assert.ok(
            response.body.length < sources['assets/app.js'].length / 2,
            `expected the brotli body (${response.body.length}) to be under half of ${sources['assets/app.js'].length}`,
        );
    });
});

test('a gzip-only client gets the gzip variant of a CSS asset', async () => {
    await withServer(async ({ port, sources }) => {
        const response = await httpGet(port, '/assets/app.css', { 'accept-encoding': 'gzip, deflate' });

        assert.equal(response.status, 200);
        assert.equal(response.headers['content-encoding'], 'gzip');
        assert.match(String(response.headers.vary), /accept-encoding/i);
        assert.match(String(response.headers['content-type']), /text\/css/);

        const decoded = await gunzip(response.body);
        assert.equal(decoded.toString(), sources['assets/app.css'].toString());
    });
});

test('a client that accepts no encoding still gets the identity asset with Vary', async () => {
    await withServer(async ({ port, sources }) => {
        const response = await httpGet(port, '/assets/app.js');

        assert.equal(response.status, 200);
        assert.equal(response.headers['content-encoding'], undefined);
        assert.match(String(response.headers.vary), /accept-encoding/i);
        assert.equal(response.body.toString(), sources['assets/app.js'].toString());
    });
});

test('already-compressed asset types are never compressed and carry no Vary', async () => {
    await withServer(async ({ port, sources }) => {
        for (const asset of ['font.woff2', 'pic.png']) {
            const response = await httpGet(port, `/assets/${asset}`, {
                'accept-encoding': 'gzip, deflate, br',
            });

            assert.equal(response.status, 200, asset);
            assert.equal(response.headers['content-encoding'], undefined, asset);
            assert.equal(response.headers.vary, undefined, asset);
            assert.equal(response.body.length, sources[`assets/${asset}`].length, asset);
        }
    });
});

test('dynamic JSON responses are compressed by the fallback middleware', async () => {
    await withServer(async ({ port }) => {
        const compressed = await httpGet(port, '/api/json', { 'accept-encoding': 'gzip' });
        assert.equal(compressed.status, 200);
        assert.equal(compressed.headers['content-encoding'], 'gzip');
        assert.match(String(compressed.headers.vary), /accept-encoding/i);

        const decoded = await gunzip(compressed.body);
        const payload = JSON.parse(decoded.toString());
        assert.equal(payload.items.length, 200);

        const identity = await httpGet(port, '/api/json');
        assert.equal(identity.headers['content-encoding'], undefined);
        assert.ok(
            compressed.body.length < identity.body.length / 2,
            `expected gzip (${compressed.body.length}) to beat identity (${identity.body.length})`,
        );
    });
});

test('server-sent event streams are left uncompressed so frames are not buffered', async () => {
    await withServer(async ({ port }) => {
        const response = await httpGet(port, '/api/stream', { 'accept-encoding': 'gzip, deflate, br' });

        assert.equal(response.status, 200);
        assert.equal(response.headers['content-encoding'], undefined);
        assert.match(response.body.toString(), /^data: /);
    });
});

test('responses below the size threshold are not compressed', async () => {
    await withServer(async ({ port }) => {
        const response = await httpGet(port, '/api/tiny', { 'accept-encoding': 'gzip, deflate, br' });

        assert.equal(response.status, 200);
        assert.equal(response.headers['content-encoding'], undefined);
        assert.equal(response.body.toString(), '{"ok":true}');
    });
});

test('an asset with no precompressed sibling falls back to on-the-fly compression', async () => {
    await withServer(async ({ port, distDir }) => {
        // Written after precompressDirectory ran, so it has no .br/.gz sibling.
        await writeFile(path.join(distDir, 'assets', 'late.js'), compressibleJs(400));

        const response = await httpGet(port, '/assets/late.js', { 'accept-encoding': 'gzip' });

        assert.equal(response.status, 200);
        assert.equal(response.headers['content-encoding'], 'gzip');
        assert.match(String(response.headers.vary), /accept-encoding/i);
        assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
    });
});

test('index.html is never served from a precompressed variant', async () => {
    await withServer(async ({ port, distDir, sources }) => {
        // The SPA entry point is rewritten at request time (router basename
        // injection in server/index.js), so a build-time variant would ship
        // stale HTML. The build must not emit one.
        await assert.rejects(() => stat(path.join(distDir, 'index.html.br')));
        await assert.rejects(() => stat(path.join(distDir, 'index.html.gz')));

        const response = await httpGet(port, '/index.html', { 'accept-encoding': 'gzip, deflate, br' });
        assert.equal(response.status, 200);
        // Still compressed, just on the fly by the fallback middleware.
        assert.equal(response.headers['content-encoding'], 'br');
        const decoded = await brotliDecompress(response.body);
        assert.equal(decoded.toString(), sources['index.html'].toString());
    });
});

test('path traversal cannot be used to reach a variant outside the asset root', async () => {
    await withServer(async ({ port }) => {
        const response = await httpGet(port, '/assets/../../../etc/passwd.js', {
            'accept-encoding': 'gzip, deflate, br',
        });

        assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
        assert.equal(response.headers['content-encoding'], undefined);
    });
});

test('setStaticAssetHeaders keeps HTML uncacheable and leaves unknown types alone', () => {
    const headers = new Map<string, string>();
    const res = {
        setHeader: (name: string, value: string) => {
            headers.set(name.toLowerCase(), value);
        },
        getHeader: (name: string) => headers.get(name.toLowerCase()),
    };

    setStaticAssetHeaders(res as never, '/dist/index.html');
    assert.equal(headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
    assert.equal(headers.get('vary'), undefined);

    headers.clear();
    setStaticAssetHeaders(res as never, '/dist/notes.md');
    assert.equal(headers.get('cache-control'), undefined);
    assert.equal(headers.get('content-encoding'), undefined);
});

test('setPublicAssetHeaders freezes fonts and nothing else under public/', () => {
    const headers = new Map<string, string>();
    const res = {
        setHeader: (name: string, value: string) => {
            headers.set(name.toLowerCase(), value);
        },
    };

    // The self-hosted fonts (issue #270) are version-stamped in their filename,
    // so a year-long immutable cache can never serve a stale face. The public/
    // static handler runs ahead of the dist/ one, so this hook — not
    // setStaticAssetHeaders — is what actually answers /fonts/*.woff2.
    setPublicAssetHeaders(res as never, '/app/public/fonts/encode-sans-v23-latin.woff2');
    assert.equal(headers.get('cache-control'), 'public, max-age=31536000, immutable');

    // Everything else in public/ keeps revalidating. sw.js is the one that
    // matters: freezing the service worker would strand clients on a dead build.
    for (const filePath of [
        '/app/public/sw.js',
        '/app/public/manifest.json',
        '/app/public/logo.svg',
        '/app/public/icons/icon-192x192.png',
        '/app/public/api-docs.html',
        '/app/public/fonts/encode-sans-OFL.txt',
    ]) {
        headers.clear();
        setPublicAssetHeaders(res as never, filePath);
        assert.equal(headers.get('cache-control'), undefined, `${filePath} should not be frozen`);
    }
});

test('precompressDirectory emits smaller siblings only where they pay off', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'precompress-'));
    try {
        await mkdir(path.join(tempDir, 'assets'), { recursive: true });
        const bigJs = compressibleJs(400);
        await writeFile(path.join(tempDir, 'assets', 'app.js'), bigJs);
        await writeFile(path.join(tempDir, 'assets', 'small.js'), 'const a = 1;\n');
        await writeFile(path.join(tempDir, 'assets', 'font.woff2'), incompressibleBytes(40_000));
        await writeFile(path.join(tempDir, 'index.html'), '<!doctype html>');

        const summary = await precompressDirectory(tempDir);

        assert.equal(summary.compressed, 1);
        assert.ok(summary.originalBytes > summary.brotliBytes);

        const br = await readFile(path.join(tempDir, 'assets', 'app.js.br'));
        const gz = await readFile(path.join(tempDir, 'assets', 'app.js.gz'));
        assert.equal((await brotliDecompress(br)).toString(), bigJs);
        assert.equal((await gunzip(gz)).toString(), bigJs);
        // Brotli should beat gzip on JS — that is why it is preferred at request time.
        assert.ok(br.length < gz.length, `expected brotli (${br.length}) < gzip (${gz.length})`);

        // Below the threshold, already-compressed, and request-time-rewritten
        // files are all skipped.
        await assert.rejects(() => stat(path.join(tempDir, 'assets', 'small.js.br')));
        await assert.rejects(() => stat(path.join(tempDir, 'assets', 'font.woff2.br')));
        await assert.rejects(() => stat(path.join(tempDir, 'index.html.br')));
        assert.ok(MIN_PRECOMPRESS_BYTES > 0);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('precompressDirectory is a no-op on a directory that does not exist', async () => {
    const summary = await precompressDirectory(path.join(tmpdir(), 'compression-missing-dir-xyz'));
    assert.equal(summary.compressed, 0);
    assert.equal(summary.scanned, 0);
});
