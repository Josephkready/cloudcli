import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
    buildHealthPayload,
    createHealthRouter,
    readBuildInfo,
} from './build-info.js';

/**
 * cloudcli#458: /health must report a per-deploy build identity (git SHA + build time)
 * so an open tab can detect a new build that semver cannot express. These pin that the
 * server parses dist/build-info.json and serves it under `build` — and keeps the old
 * response shape (no `build` key) when the file is absent, so the client's semver
 * fallback stays reachable.
 */

const SAMPLE_INFO = { sha: 'abc1234', built_at: '2026-09-11T00:00:00.000Z' };

async function withAppRoot() {
    const root = await mkdtemp(path.join(tmpdir(), 'cloudcli-build-info-'));
    await mkdir(path.join(root, 'dist'), { recursive: true });
    return {
        root,
        cleanup: () => rm(root, { recursive: true, force: true }),
    };
}

function startServer(build) {
    const app = express();
    app.use(createHealthRouter({ installMode: 'git', version: '1.36.3', build }));
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({
                port: typeof address === 'object' && address ? address.port : 0,
                close: () => new Promise((done) => server.close(() => done())),
            });
        });
    });
}

function get(port, route) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: route, method: 'GET' }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            });
        });
        req.on('error', reject);
        req.end();
    });
}

test('readBuildInfo parses dist/build-info.json under the app root', async () => {
    const { root, cleanup } = await withAppRoot();
    try {
        await writeFile(path.join(root, 'dist', 'build-info.json'), JSON.stringify(SAMPLE_INFO));
        assert.deepEqual(readBuildInfo(root), SAMPLE_INFO);
    } finally {
        await cleanup();
    }
});

test('readBuildInfo returns null when the file is missing, malformed, or empty of identity', async () => {
    const { root, cleanup } = await withAppRoot();
    try {
        assert.equal(readBuildInfo(root), null);
        await writeFile(path.join(root, 'dist', 'build-info.json'), 'not json{');
        assert.equal(readBuildInfo(root), null);
        await writeFile(path.join(root, 'dist', 'build-info.json'), JSON.stringify({ sha: '', built_at: '' }));
        assert.equal(readBuildInfo(root), null);
    } finally {
        await cleanup();
    }
});

test('/health includes build when build info exists', async () => {
    const server = await startServer(SAMPLE_INFO);
    try {
        const body = await get(server.port, '/health');
        assert.equal(body.status, 'ok');
        assert.equal(body.installMode, 'git');
        assert.equal(body.version, '1.36.3');
        assert.deepEqual(body.build, SAMPLE_INFO);
    } finally {
        await server.close();
    }
});

test('/health omits the build key when build info is absent (old shape preserved)', async () => {
    const server = await startServer(null);
    try {
        const body = await get(server.port, '/health');
        assert.equal('build' in body, false);
        assert.equal(body.version, '1.36.3');
    } finally {
        await server.close();
    }
});

test('buildHealthPayload only adds build when present', () => {
    const base = { status: 'ok', timestamp: 't', installMode: 'git', version: '1.36.3' };
    const withBuild = buildHealthPayload({ ...base, build: SAMPLE_INFO });
    assert.deepEqual(withBuild.build, SAMPLE_INFO);
    assert.equal('build' in buildHealthPayload(base), false);
});
