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
    runPrecompressCli,
} from '../shared/precompress-assets.js';

import {
    createCompressionMiddleware,
    createPrecompressedAssets,
    mountStaticAssets,
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

/** Raw HTTP request: no automatic decompression, so headers and byte counts are exact. */
function httpRequest(
    port: number,
    requestPath: string,
    { method = 'GET', headers = {} }: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path: requestPath, method, headers },
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

function httpGet(
    port: number,
    requestPath: string,
    headers: Record<string, string> = {},
): ReturnType<typeof httpRequest> {
    return httpRequest(port, requestPath, { headers });
}

interface Fixture {
    port: number;
    distDir: string;
    publicDir: string;
    sources: Record<string, Buffer>;
    /** public/ files, in the copies vite would have duplicated into dist/. */
    shadowed: Record<string, { public: Buffer; dist: Buffer }>;
}

/**
 * Build public/ + dist/ fixtures, precompress dist exactly like the build does,
 * and mount the same middleware stack server/index.js mounts (compression ->
 * public static -> precompressed variants -> dist static), so these assertions
 * are about real response headers rather than a hand-rolled approximation.
 */
async function withServer(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'compression-'));
    const distDir = path.join(tempDir, 'dist');
    const publicDir = path.join(tempDir, 'public');
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

    // vite copies public/ into dist/, so these paths exist in BOTH trees and
    // whichever handler is mounted first is the one that answers. The two copies
    // are deliberately given different bytes so a response identifies its source.
    const shadowed: Record<string, { public: Buffer; dist: Buffer }> = {
        'fonts/encode-sans-v23-latin.woff2': {
            public: incompressibleBytes(20_000),
            dist: incompressibleBytes(20_001),
        },
        'fonts/encode-sans-OFL.txt': {
            public: Buffer.from(`OFL from public\n${'licence text '.repeat(400)}`),
            dist: Buffer.from(`OFL from dist\n${'licence text '.repeat(400)}`),
        },
        'sw.js': {
            public: Buffer.from(`// sw from public\n${compressibleJs(200)}`),
            dist: Buffer.from(`// sw from dist\n${compressibleJs(200)}`),
        },
    };
    for (const [relative, copies] of Object.entries(shadowed)) {
        await mkdir(path.dirname(path.join(publicDir, relative)), { recursive: true });
        await mkdir(path.dirname(path.join(distDir, relative)), { recursive: true });
        await writeFile(path.join(publicDir, relative), copies.public);
        await writeFile(path.join(distDir, relative), copies.dist);
    }

    await precompressDirectory(distDir, { shadowRoot: publicDir });

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
    // The same call server/index.js makes, rather than a re-listing of the three
    // handlers here: a reorder in index.js would otherwise ship green.
    mountStaticAssets(app, { publicDir, distDir });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
        await fn({ port, distDir, publicDir, sources, shadowed });
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

test('public/ answers ahead of dist/, so fonts freeze and sw.js does not', async () => {
    // vite copies public/ into dist/, so both handlers can serve these paths and
    // only the mount order decides which. That order is the whole cache policy:
    // the dist/ hook freezes anything matching a hashed-asset name for a year,
    // which would pin sw.js to a dead build. Asserted over HTTP because the
    // pure-function tests below cannot see the ordering at all.
    await withServer(async ({ port, shadowed }) => {
        const font = await httpGet(port, '/fonts/encode-sans-v23-latin.woff2', {
            'accept-encoding': 'gzip, deflate, br',
        });
        assert.equal(font.status, 200);
        assert.equal(font.headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.equal(font.headers['content-encoding'], undefined);
        assert.deepEqual(font.body, shadowed['fonts/encode-sans-v23-latin.woff2'].public);

        // The one that must NOT be frozen. express.static's default is
        // `public, max-age=0`; setStaticAssetHeaders would make it immutable.
        const sw = await httpGet(port, '/sw.js', { 'accept-encoding': 'gzip' });
        assert.equal(sw.status, 200);
        assert.match(String(sw.headers['cache-control']), /max-age=0/);
        assert.doesNotMatch(String(sw.headers['cache-control']), /immutable/);
        assert.equal(
            (await gunzip(sw.body)).toString(),
            shadowed['sw.js'].public.toString(),
        );
    });
});

test('files shadowed by public/ are not precompressed into dist/', async () => {
    // Their dist/ copies can never reach the wire, so a .br sibling there is
    // build cost for nothing.
    await withServer(async ({ distDir, publicDir }) => {
        for (const relative of ['sw.js', 'fonts/encode-sans-OFL.txt']) {
            await stat(path.join(distDir, relative));
            await assert.rejects(
                () => stat(path.join(distDir, `${relative}.br`)),
                `dist/${relative}.br is dead build output`,
            );
            await assert.rejects(() => stat(path.join(distDir, `${relative}.gz`)));
        }
        // The shadow root itself is never written to.
        await assert.rejects(() => stat(path.join(publicDir, 'sw.js.br')));
        // ...and assets with no public/ twin are still compressed as usual.
        await stat(path.join(distDir, 'assets', 'app.js.br'));
    });
});

test('a HEAD request reports the precompressed variant it would have sent', async () => {
    await withServer(async ({ port, distDir }) => {
        const head = await httpRequest(port, '/assets/app.js', {
            method: 'HEAD',
            headers: { 'accept-encoding': 'gzip, deflate, br' },
        });

        assert.equal(head.status, 200);
        assert.equal(head.headers['content-encoding'], 'br');
        assert.match(String(head.headers['content-type']), /javascript/);
        assert.match(String(head.headers.vary), /accept-encoding/i);
        assert.equal(head.body.length, 0);
        // Content-Length must describe the compressed bytes, not the original,
        // or a client would wait for a body that is never coming.
        const variant = await stat(path.join(distDir, 'assets', 'app.js.br'));
        assert.equal(Number(head.headers['content-length']), variant.size);
    });
});

test('each encoding gets its own ETag so a conditional GET cannot cross variants', async () => {
    await withServer(async ({ port }) => {
        const brotli = await httpGet(port, '/assets/app.js', { 'accept-encoding': 'br' });
        const gzip = await httpGet(port, '/assets/app.js', { 'accept-encoding': 'gzip' });
        const identity = await httpGet(port, '/assets/app.js');

        for (const response of [brotli, gzip, identity]) {
            assert.ok(response.headers.etag, 'every variant must carry an ETag');
        }
        // Three different bodies on the wire, so three different validators.
        // Sharing one would let a cache revalidate a brotli entry against the
        // gzip file and serve a body the client cannot decode.
        const etags = new Set([brotli.headers.etag, gzip.headers.etag, identity.headers.etag]);
        assert.equal(etags.size, 3, `expected 3 distinct ETags, got ${[...etags].join(', ')}`);

        // Same encoding + matching validator -> 304 with no body.
        const revalidated = await httpGet(port, '/assets/app.js', {
            'accept-encoding': 'br',
            'if-none-match': String(brotli.headers.etag),
        });
        assert.equal(revalidated.status, 304);
        assert.equal(revalidated.body.length, 0);

        // The brotli validator must not satisfy a gzip request.
        const crossed = await httpGet(port, '/assets/app.js', {
            'accept-encoding': 'gzip',
            'if-none-match': String(brotli.headers.etag),
        });
        assert.equal(crossed.status, 200);
        assert.equal(crossed.headers['content-encoding'], 'gzip');
    });
});

test('path traversal cannot be used to reach a variant outside the asset root', async () => {
    // Deliberately a unit test on the rewriter rather than an HTTP round-trip.
    // Through the full stack express.static rejects `..` on its own, so the
    // request 404s whether or not this middleware checks containment — the
    // assertion would pass with the guard deleted. Here the only thing under
    // test is whether `req.url` gets pointed at a file outside the root.
    const tempDir = await mkdtemp(path.join(tmpdir(), 'compression-traversal-'));
    try {
        const distDir = path.join(tempDir, 'dist');
        await mkdir(path.join(distDir, 'assets'), { recursive: true });
        await writeFile(path.join(distDir, 'assets', 'app.js'), compressibleJs(400));

        // Bait: a real file with a real .br sibling, sitting outside the asset
        // root. Without it the traversal would be rejected by the "no such
        // variant on disk" check instead, and this test would prove nothing.
        const outsideDir = path.join(tempDir, 'outside');
        await mkdir(outsideDir, { recursive: true });
        await writeFile(path.join(outsideDir, 'secret.js'), compressibleJs(400));

        await precompressDirectory(tempDir);
        await stat(path.join(outsideDir, 'secret.js.br'));

        const middleware = createPrecompressedAssets({ root: distDir });
        const call = (url: string): { url: string; nexted: boolean } => {
            const req = { method: 'GET', url, headers: { 'accept-encoding': 'br' } };
            let nexted = false;
            middleware(req as never, {} as never, () => {
                nexted = true;
            });
            return { url: req.url, nexted };
        };

        // Positive control: an in-root asset IS rewritten, so the negative case
        // below is a rejection and not an accident of the fixture.
        assert.equal(call('/assets/app.js').url, '/assets/app.js.br');

        for (const escaping of [
            '/assets/../../outside/secret.js',
            '/../outside/secret.js',
            '/assets/%2e%2e/%2e%2e/outside/secret.js',
        ]) {
            const result = call(escaping);
            assert.equal(result.url, escaping, `${escaping} must not be rewritten`);
            assert.equal(result.nexted, true, `${escaping} must be passed on untouched`);
        }
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
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
        '/app/public/icons/icon-512x512.png',
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
    // The library call is deliberately tolerant (a directory that vanishes
    // mid-walk must not abort a build). Turning that into a hard failure is the
    // CLI's job — see the runPrecompressCli tests below.
    const summary = await precompressDirectory(path.join(tmpdir(), 'compression-missing-dir-xyz'));
    assert.equal(summary.compressed, 0);
    assert.equal(summary.scanned, 0);
});

test('precompressDirectory skips files a shadowRoot serves first', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'precompress-shadow-'));
    try {
        const distDir = path.join(tempDir, 'dist');
        const publicDir = path.join(tempDir, 'public');
        await mkdir(path.join(distDir, 'fonts'), { recursive: true });
        await mkdir(path.join(publicDir, 'fonts'), { recursive: true });

        // Only sw.js and fonts/licence.txt have a public/ twin; app.js does not.
        await writeFile(path.join(distDir, 'sw.js'), compressibleJs(400));
        await writeFile(path.join(publicDir, 'sw.js'), compressibleJs(400));
        await writeFile(path.join(distDir, 'fonts', 'licence.txt'), 'licence text '.repeat(400));
        await writeFile(path.join(publicDir, 'fonts', 'licence.txt'), 'licence text '.repeat(400));
        await mkdir(path.join(distDir, 'assets'), { recursive: true });
        await writeFile(path.join(distDir, 'assets', 'app.js'), compressibleJs(400));

        const summary = await precompressDirectory(distDir, { shadowRoot: publicDir });

        assert.equal(summary.compressed, 1);
        // The skip is counted, so a misconfigured shadow root shows up as a
        // number rather than as a quietly smaller build.
        assert.equal(summary.shadowed, 2);
        await stat(path.join(distDir, 'assets', 'app.js.br'));
        await assert.rejects(() => stat(path.join(distDir, 'sw.js.br')));
        await assert.rejects(() => stat(path.join(distDir, 'fonts', 'licence.txt.br')));

        // Without the option they are compressed again, which is what makes the
        // assertions above about the shadow check and not about the fixture.
        const unshadowed = await precompressDirectory(distDir);
        assert.equal(unshadowed.compressed, 3);
        await stat(path.join(distDir, 'sw.js.br'));
        await stat(path.join(distDir, 'fonts', 'licence.txt.br'));

        // A shadow root that does not exist is simply no shadowing.
        assert.equal(
            (await precompressDirectory(distDir, { shadowRoot: path.join(tempDir, 'nope') })).compressed,
            3,
        );
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('re-running precompressDirectory over an already-precompressed tree is stable', async () => {
    // The dante deploy re-runs the build over a staging dir that may already
    // hold variants from a previous attempt, and `npm run build:client` can be
    // run twice in a row locally. Neither may produce `.br.br` chains or churn.
    const tempDir = await mkdtemp(path.join(tmpdir(), 'precompress-rerun-'));
    try {
        await mkdir(path.join(tempDir, 'assets'), { recursive: true });
        await writeFile(path.join(tempDir, 'assets', 'app.js'), compressibleJs(400));

        const first = await precompressDirectory(tempDir);
        const firstBr = await readFile(path.join(tempDir, 'assets', 'app.js.br'));

        const second = await precompressDirectory(tempDir);
        const secondBr = await readFile(path.join(tempDir, 'assets', 'app.js.br'));

        assert.equal(second.compressed, first.compressed);
        assert.equal(second.originalBytes, first.originalBytes);
        assert.equal(second.brotliBytes, first.brotliBytes);
        assert.equal(second.gzipBytes, first.gzipBytes);
        assert.deepEqual(secondBr, firstBr);
        // The second walk does see the two variants the first run wrote — it
        // just refuses to compress them again.
        assert.equal(second.scanned, first.scanned + 2);
        await assert.rejects(() => stat(path.join(tempDir, 'assets', 'app.js.br.br')));
        await assert.rejects(() => stat(path.join(tempDir, 'assets', 'app.js.gz.br')));
        await assert.rejects(() => stat(path.join(tempDir, 'assets', 'app.js.br.gz')));
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('PRECOMPRESS_BROTLI_QUALITY trades size for build speed, and an explicit option wins', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'precompress-quality-'));
    const previous = process.env.PRECOMPRESS_BROTLI_QUALITY;
    const source = compressibleJs(400);

    async function compressWith(name: string, options?: { brotliQuality: number }): Promise<Buffer> {
        const dir = path.join(tempDir, name);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'app.js'), source);
        await precompressDirectory(dir, options);
        return readFile(path.join(dir, 'app.js.br'));
    }

    try {
        const best = await compressWith('default');

        process.env.PRECOMPRESS_BROTLI_QUALITY = '1';
        const fast = await compressWith('fast');
        assert.ok(
            best.length < fast.length,
            `expected default quality 11 (${best.length}) to beat quality 1 (${fast.length})`,
        );
        assert.equal((await brotliDecompress(fast)).toString(), source);

        // An explicit option beats the environment, which is what lets a caller
        // stay deterministic regardless of the shell it was launched from.
        assert.deepEqual(await compressWith('explicit', { brotliQuality: 11 }), best);

        // A junk value falls back to the default rather than throwing or
        // silently compressing at quality 0.
        process.env.PRECOMPRESS_BROTLI_QUALITY = 'not-a-number';
        assert.deepEqual(await compressWith('junk'), best);
    } finally {
        if (previous === undefined) {
            delete process.env.PRECOMPRESS_BROTLI_QUALITY;
        } else {
            process.env.PRECOMPRESS_BROTLI_QUALITY = previous;
        }
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('the precompress CLI exits non-zero when its target is missing or not a directory', async () => {
    // A typo'd path or a changed vite `outDir` must not read as "nothing here
    // was worth compressing" — that would be a green build shipping every
    // bundle uncompressed.
    const tempDir = await mkdtemp(path.join(tmpdir(), 'precompress-cli-'));
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
    };

    try {
        const missing = path.join(tempDir, 'no-such-dist');
        assert.equal(await runPrecompressCli(missing), 1);
        assert.match(errors.at(-1) ?? '', /does not exist/);
        assert.match(errors.at(-1) ?? '', new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

        const file = path.join(tempDir, 'dist-is-a-file');
        await writeFile(file, 'not a directory');
        assert.equal(await runPrecompressCli(file), 1);
        assert.match(errors.at(-1) ?? '', /not a directory/);

        // The happy path still succeeds, so the guard is not simply failing.
        const dist = path.join(tempDir, 'dist');
        await mkdir(path.join(dist, 'assets'), { recursive: true });
        await writeFile(path.join(dist, 'assets', 'app.js'), compressibleJs(400));
        assert.equal(await runPrecompressCli(dist), 0);
        await stat(path.join(dist, 'assets', 'app.js.br'));

        // An existing but empty directory is a legitimate no-op, not a failure.
        const empty = path.join(tempDir, 'empty');
        await mkdir(empty, { recursive: true });
        assert.equal(await runPrecompressCli(empty), 0);

        // A shadow root equal to the target would mark every file as shadowed
        // by itself: nothing compresses and the build still goes green. That is
        // the same silent success the missing-target guard exists to prevent.
        assert.equal(await runPrecompressCli(dist, dist), 1);
        assert.match(errors.at(-1) ?? '', /shadow root must differ/);

        // A different shadow root is still accepted, so the guard is specific.
        const shadow = path.join(tempDir, 'public');
        await mkdir(shadow, { recursive: true });
        assert.equal(await runPrecompressCli(dist, shadow), 0);
    } finally {
        console.error = realError;
        await rm(tempDir, { recursive: true, force: true });
    }
});
