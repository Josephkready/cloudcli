import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// APP_ROOT resolves to this repo's root (findAppRoot walks up from
// server/index.js's own directory). Some environments (e.g. a CI image that
// ran `npm run build` while baking) may already have a real dist/ here, so
// tests below that depend on dist's presence/absence make no assumption about
// the ambient state — they move any pre-existing dist/ aside and restore it.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(APP_ROOT, 'dist');
const DIST_INDEX_PATH = path.join(DIST_DIR, 'index.html');

// server/index.js does real work (DB init, app-construction, route mounting)
// as soon as it is imported: express() + wss are built at module scope so the
// route stack is testable. What must NOT happen on import is starting the
// actual server — `startServer()` (listen, session watcher, timers) only runs
// when the file is the process entry point (see the `isMainModule()` guard
// added in server/index.js). This test proves both halves: importing is
// side-effect-light enough to exercise the app directly, and no port gets
// bound until we call `server.listen` ourselves below.
const tempDirectory = await mkdtemp(path.join('/var/tmp', 'index-route-'));
process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
process.env.VITE_AUTH_DISABLED = 'true';
process.env.SERVER_PORT = '0';

// The full schema (users table etc.) must exist before any route under
// authenticateToken's auth-bypass path runs `userDb.getFirstUser()`, and
// before the default user is seeded. server/index.js's own startup does this
// inside startServer(), which we deliberately never call here.
const { initializeDatabase } = await import('./modules/database/init-db.js');
await initializeDatabase();

const { app, server } = await import('./index.js');

test.after(async () => {
  await new Promise<void>((resolve) => {
    if (server.listening) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
  await rm(tempDirectory, { recursive: true, force: true });
});

async function withRunningServer(
  runTest: (baseUrl: string) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await runTest(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('importing server/index.js does not start listening on its own', () => {
  // No listen() has been called yet at this point in the file — proves the
  // main-module guard actually gated startServer() rather than a no-op.
  assert.equal(server.listening, false);
  assert.equal(typeof app, 'function');
});

test('GET /health responds without auth', async () => {
  await withRunningServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = await response.json() as { status: string };
    assert.equal(body.status, 'ok');
  });
});

test('GET /nonexistent-file.png returns a plain 404 (static-asset short-circuit)', async () => {
  await withRunningServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/nonexistent-file.png`);
    assert.equal(response.status, 404);
    const text = await response.text();
    assert.equal(text, 'Not found');
  });
});

test('GET /some/spa/route redirects to the Vite dev server when no build exists', async () => {
  // Some CI environments bake an image that has already run `npm run build`,
  // so a real dist/ may exist ambiently. This test's premise is "no build",
  // so it moves any pre-existing dist/ aside for its duration and restores it
  // afterward rather than assuming a clean checkout.
  const backupDir = existsSync(DIST_DIR) ? `${DIST_DIR}.bak-${Date.now()}` : null;
  if (backupDir) {
    await rename(DIST_DIR, backupDir);
  }

  try {
    await withRunningServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/some/spa/route`, { redirect: 'manual' });
      assert.equal(response.status, 302);
      const location = response.headers.get('location');
      assert.match(location ?? '', /:5173$/);
    });
  } finally {
    if (backupDir) {
      await rename(backupDir, DIST_DIR);
    }
  }
});

test('GET / and /index.html serve the built SPA with the router-basename injected, when dist exists', async () => {
  // A real dist/index.html has to exist under APP_ROOT for
  // sendIndexHtmlWithBasename's happy path to run. dist/ is gitignored build
  // output, but some CI environments bake an image with a real one already
  // present — back that up rather than clobbering/deleting it so this test
  // works the same in a clean checkout or a pre-built image.
  const backupDir = existsSync(DIST_DIR) ? `${DIST_DIR}.bak-${Date.now()}` : null;
  if (backupDir) {
    await rename(DIST_DIR, backupDir);
  }
  await mkdir(DIST_DIR, { recursive: true });
  await writeFile(
    DIST_INDEX_PATH,
    '<!doctype html><html><head></head><body><script>window.__ROUTER_BASENAME__="__PLACEHOLDER__"</script></body></html>',
  );

  try {
    await withRunningServer(async (baseUrl) => {
      for (const requestPath of ['/', '/index.html']) {
        const response = await fetch(`${baseUrl}${requestPath}`);
        assert.equal(response.status, 200, requestPath);
        assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', requestPath);
        const html = await response.text();
        assert.match(html, /window\.__ROUTER_BASENAME__/, requestPath);
      }
    });
  } finally {
    await rm(DIST_DIR, { recursive: true, force: true });
    if (backupDir) {
      await rename(backupDir, DIST_DIR);
    }
  }
});

test('GET / re-reads dist/index.html when its mtime changes, instead of serving a stale in-memory cache', async () => {
  // sendIndexHtmlWithBasename caches the transformed HTML in memory keyed by
  // mtime (see server/index.js) so it doesn't do a sync read+transform on
  // every request. This proves the cache is invalidated on rebuild rather
  // than loaded once and stuck for the process's lifetime.
  const backupDir = existsSync(DIST_DIR) ? `${DIST_DIR}.bak-${Date.now()}` : null;
  if (backupDir) {
    await rename(DIST_DIR, backupDir);
  }
  await mkdir(DIST_DIR, { recursive: true });

  try {
    await withRunningServer(async (baseUrl) => {
      await writeFile(DIST_INDEX_PATH, '<!doctype html><html><body>build-one</body></html>');
      // Force a distinct mtime even if both writes land in the same
      // millisecond on a coarse filesystem clock.
      const past = new Date(Date.now() - 60_000);
      await utimes(DIST_INDEX_PATH, past, past);

      const first = await fetch(`${baseUrl}/`);
      assert.match(await first.text(), /build-one/);

      await writeFile(DIST_INDEX_PATH, '<!doctype html><html><body>build-two</body></html>');
      const now = new Date();
      await utimes(DIST_INDEX_PATH, now, now);

      const second = await fetch(`${baseUrl}/`);
      const secondHtml = await second.text();
      assert.match(secondHtml, /build-two/);
      assert.doesNotMatch(secondHtml, /build-one/);
    });
  } finally {
    await rm(DIST_DIR, { recursive: true, force: true });
    if (backupDir) {
      await rename(backupDir, DIST_DIR);
    }
  }
});
