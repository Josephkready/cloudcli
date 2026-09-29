import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

async function readJson(res: Response): Promise<any> {
  return res.json();
}


/**
 * Boots assets.routes.ts against a real temp HOME, so `~/.cloudcli/assets`
 * resolves inside an isolated directory. Real multer + real filesystem, no
 * mocking of the service (the traversal-safety logic lives there and is
 * already covered by image-assets.service.test.ts) -- this file exercises the
 * HTTP wiring: upload validation, filename sanitization, and the serving
 * route's content-type/traversal/error handling.
 */
async function withAssetsServer(fn: (baseUrl: string) => Promise<void>) {
  const originalHome = process.env.HOME;
  const homeDir = await mkdtemp(path.join(tmpdir(), 'assets-home-'));
  process.env.HOME = homeDir;

  const { default: assetsRouter } = await import('../assets.routes.js');
  const app = express();
  app.use('/api/assets', assetsRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}/api/assets`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  }
}

function pngUploadBody(fieldName: string, filename: string): { body: FormData } {
  const form = new FormData();
  // Minimal valid-enough PNG signature bytes; the route only checks mimetype.
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  form.append(fieldName, new Blob([bytes], { type: 'image/png' }), filename);
  return { body: form };
}

test('POST /images stores an uploaded PNG and returns its record', async () => {
  await withAssetsServer(async (baseUrl) => {
    const { body } = pngUploadBody('images', 'photo.png');
    const res = await fetch(`${baseUrl}/images`, { method: 'POST', body });
    assert.equal(res.status, 200);
    const json = await readJson(res);
    assert.equal(json.images.length, 1);
    assert.equal(json.images[0].name, 'photo.png');
    assert.equal(json.images[0].mimeType, 'image/png');
    assert.match(json.images[0].path, /\.cloudcli\/assets\/.*photo\.png$/);
  });
});

test('POST /images rejects a disallowed file type', async () => {
  await withAssetsServer(async (baseUrl) => {
    const form = new FormData();
    form.append('images', new Blob([new Uint8Array([1, 2, 3])], { type: 'text/plain' }), 'notes.txt');
    const res = await fetch(`${baseUrl}/images`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
    assert.match((await readJson(res)).error, /Invalid file type/);
  });
});

test('POST /images requires at least one file', async () => {
  await withAssetsServer(async (baseUrl) => {
    const form = new FormData();
    const res = await fetch(`${baseUrl}/images`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
    assert.match((await readJson(res)).error, /No image files provided/);
  });
});

test('POST /images sanitizes special characters out of the stored filename', async () => {
  await withAssetsServer(async (baseUrl) => {
    const { body } = pngUploadBody('images', 'weird name!@#.png');
    const res = await fetch(`${baseUrl}/images`, { method: 'POST', body });
    assert.equal(res.status, 200);
    const json = await readJson(res);
    assert.doesNotMatch(json.images[0].path, /[!@#]/);
    assert.match(json.images[0].path, /weird_name/);
  });
});

test('GET /images/:filename serves a previously uploaded PNG with safe headers', async () => {
  await withAssetsServer(async (baseUrl) => {
    const { body } = pngUploadBody('images', 'photo.png');
    const uploadRes = await fetch(`${baseUrl}/images`, { method: 'POST', body });
    const uploaded = (await readJson(uploadRes)).images[0];
    const storedFilename = path.basename(uploaded.path);

    const res = await fetch(`${baseUrl}/images/${storedFilename}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-disposition'), null);
    const buf = new Uint8Array(await res.arrayBuffer());
    assert.equal(buf[0], 0x89);
  });
});

test('GET /images/:filename forces a download disposition for SVG assets', async () => {
  await withAssetsServer(async (baseUrl) => {
    // Write an SVG directly into the assets dir to avoid relying on multer's
    // svg allow-list edge behaviour; this exercises the serving route only.
    const assetsDir = path.join(process.env.HOME as string, '.cloudcli', 'assets');
    await mkdir(assetsDir, { recursive: true });
    await writeFile(path.join(assetsDir, 'icon.svg'), '<svg></svg>');

    const res = await fetch(`${baseUrl}/images/icon.svg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.equal(res.headers.get('content-disposition'), 'attachment');
  });
});

test('GET /images/:filename 400s for a path-traversal filename', async () => {
  await withAssetsServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/images/${encodeURIComponent('../../etc/passwd')}`);
    assert.equal(res.status, 400);
    assert.match((await readJson(res)).error, /Invalid asset filename/);
  });
});

test('GET /images/:filename 404s for a filename that does not exist', async () => {
  await withAssetsServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/images/does-not-exist.png`);
    assert.equal(res.status, 404);
    assert.match((await readJson(res)).error, /Asset not found/);
  });
});

test('GET /images/:filename sends a long-lived immutable Cache-Control and an ETag', async () => {
  await withAssetsServer(async (baseUrl) => {
    const { body } = pngUploadBody('images', 'photo.png');
    const uploadRes = await fetch(`${baseUrl}/images`, { method: 'POST', body });
    const uploaded = (await readJson(uploadRes)).images[0];
    const storedFilename = path.basename(uploaded.path);

    const res = await fetch(`${baseUrl}/images/${storedFilename}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(res.headers.get('etag') || '', /^".+"$/);
  });
});

test('GET /images/:filename returns 304 when If-None-Match matches the current ETag', async () => {
  await withAssetsServer(async (baseUrl) => {
    const { body } = pngUploadBody('images', 'photo.png');
    const uploadRes = await fetch(`${baseUrl}/images`, { method: 'POST', body });
    const uploaded = (await readJson(uploadRes)).images[0];
    const storedFilename = path.basename(uploaded.path);

    const first = await fetch(`${baseUrl}/images/${storedFilename}`);
    const etag = first.headers.get('etag');
    assert.ok(etag);

    const second = await fetch(`${baseUrl}/images/${storedFilename}`, {
      headers: { 'If-None-Match': etag as string },
    });
    assert.equal(second.status, 304);
    const bodyBytes = await second.arrayBuffer();
    assert.equal(bodyBytes.byteLength, 0);
  });
});
