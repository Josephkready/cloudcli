import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

async function readJson(res: Response): Promise<any> {
  return res.json();
}


// Full-stack coverage for the auth router's actual routes (GET /status,
// POST /register, POST /login validation, GET /user, POST /logout) against a
// real, fresh sqlite DB -- not just the exported handler factories (those are
// covered in auth.login.test.ts / auth.logout.test.ts / auth.registration.test.ts).
//
// auth.js holds a module-scoped `db` connection captured at import time, and
// IS_PLATFORM/AUTH_DISABLED are frozen at import time too -- so this whole
// flow runs as ONE sequential scenario against a single import/boot/DB,
// rather than one `withAuthServer` per assertion (which would leave later
// tests holding a stale/closed `db` reference from the first import).

test('auth router: status -> register -> login -> user -> logout end-to-end', async () => {
  process.env.VITE_IS_PLATFORM = 'false';
  process.env.VITE_AUTH_DISABLED = 'false';

  const tempDir = await mkdtemp(path.join(tmpdir(), 'auth-routes-'));
  const dbPath = path.join(tempDir, 'auth.db');

  const { closeConnection } = await import('../../modules/database/connection.js');
  const { initializeDatabase } = await import('../../modules/database/init-db.js');

  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  await initializeDatabase();

  const { default: authRouter } = await import('../auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}/api/auth`;

  try {
    // --- GET /status before any user exists ---
    const before = await fetch(`${baseUrl}/status`);
    assert.equal(before.status, 200);
    assert.deepEqual(await readJson(before), { needsSetup: true, isAuthenticated: false });

    // --- POST /register validation ---
    const missing = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice' }),
    });
    assert.equal(missing.status, 400);

    const tooShort = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ab', password: 'short' }),
    });
    assert.equal(tooShort.status, 400);
    assert.match((await readJson(tooShort)).error, /at least 3 characters/);

    // --- POST /register success ---
    const register = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'correct-horse' }),
    });
    assert.equal(register.status, 200);
    const registerBody = await readJson(register);
    assert.equal(registerBody.success, true);
    assert.equal(registerBody.user.username, 'alice');
    assert.equal(typeof registerBody.token, 'string');

    // --- GET /status after a user exists ---
    const after = await fetch(`${baseUrl}/status`);
    assert.deepEqual(await readJson(after), { needsSetup: false, isAuthenticated: false });

    // --- POST /register rejects a second user (single-user system) ---
    const second = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'another-pass' }),
    });
    assert.equal(second.status, 403);
    assert.match((await readJson(second)).error, /single-user system/);

    // --- POST /login validation ---
    const noPassword = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice' }),
    });
    assert.equal(noPassword.status, 400);
    assert.match((await readJson(noPassword)).error, /Username and password are required/);

    // --- POST /login success ---
    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'correct-horse' }),
    });
    assert.equal(login.status, 200);
    const { token } = await readJson(login);
    assert.equal(typeof token, 'string');

    // --- GET /user ---
    const authed = await fetch(`${baseUrl}/user`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(authed.status, 200);
    assert.equal((await readJson(authed)).user.username, 'alice');

    const unauthed = await fetch(`${baseUrl}/user`);
    assert.equal(unauthed.status, 401);

    // --- POST /logout revokes the token; the same token then fails auth ---
    const logout = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(logout.status, 200);
    assert.equal((await readJson(logout)).success, true);

    const reuseAfterLogout = await fetch(`${baseUrl}/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(reuseAfterLogout.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeConnection();
    await rm(tempDir, { recursive: true, force: true });
  }
});
