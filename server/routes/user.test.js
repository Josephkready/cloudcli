import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { spawnAsync } from '../utils/spawnAsync.js';

// The Git panel and command palette were removed in #546/#555, but the
// onboarding identity step (src/components/onboarding/view/Onboarding.tsx)
// still calls GET/POST /api/user/git-config to read and save the user's git
// identity. #555 originally deleted these routes as "only used by the git
// settings tab" -- this is the regression test that would have caught it:
// if the routes go missing again, onboarding starts 404ing.
//
// Follows the same real-DB, real-router, sequential-scenario shape as
// auth.routes.test.ts: user.js's routes go through userDb, which holds a
// module-scoped connection captured at import time, so everything below
// runs against one temp DB import rather than one server per assertion.
//
// `git` is genuinely absent in the CI container (node:22-slim ships without
// it). The route itself already degrades gracefully with no git on PATH
// (getSystemGitConfig / the `git config --global` write both swallow the
// error), so every assertion below runs everywhere. Only the extra check
// that confirms the write actually landed in a real git config is
// skip-guarded -- that one needs a real `git` binary to verify against.

const hasGit = await spawnAsync('git', ['--version']).then(() => true, () => false);

test('GET/POST /api/user/git-config: the route onboarding\'s identity step depends on', async () => {
  process.env.VITE_IS_PLATFORM = 'false';
  process.env.VITE_AUTH_DISABLED = 'false';

  const tempDir = await mkdtemp(path.join(tmpdir(), 'user-routes-'));
  const dbPath = path.join(tempDir, 'user-routes.db');

  // Point any `git config --global` the route performs at a throwaway file,
  // never the developer's/CI runner's own config, and never causing a
  // pre-existing global git identity to leak into the "unset" assertions.
  const gitHomeDir = await mkdtemp(path.join(tmpdir(), 'user-routes-githome-'));
  const gitConfigPath = path.join(gitHomeDir, '.gitconfig');
  await writeFile(gitConfigPath, '', 'utf8');
  const previousGitEnv = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
  process.env.HOME = gitHomeDir;
  delete process.env.XDG_CONFIG_HOME;

  const { closeConnection } = await import('../modules/database/connection.js');
  const { initializeDatabase } = await import('../modules/database/init-db.js');

  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  await initializeDatabase();

  const { default: authRouter } = await import('./auth.js');
  const { default: userRouter } = await import('./user.js');

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/user', userRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // A fresh user, registered the same way auth.routes.test.ts does it.
    const register = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'onboarder', password: 'correct-horse' }),
    });
    assert.equal(register.status, 200);
    const { token } = await register.json();
    assert.equal(typeof token, 'string');
    const authHeaders = { Authorization: `Bearer ${token}` };

    // --- the route must exist and require auth (not 404) ---
    const unauthed = await fetch(`${baseUrl}/api/user/git-config`);
    assert.equal(unauthed.status, 401, 'route must be mounted and auth-gated, not missing');

    // --- GET before anything is saved: no DB row, no global git identity ---
    const before = await fetch(`${baseUrl}/api/user/git-config`, { headers: authHeaders });
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), {
      success: true,
      gitName: null,
      gitEmail: null,
    });

    // --- POST validation: missing fields ---
    const missing = await fetch(`${baseUrl}/api/user/git-config`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitName: 'Ada Lovelace' }),
    });
    assert.equal(missing.status, 400);

    // --- POST validation: malformed email ---
    const badEmail = await fetch(`${baseUrl}/api/user/git-config`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitName: 'Ada Lovelace', gitEmail: 'not-an-email' }),
    });
    assert.equal(badEmail.status, 400);

    // --- POST success: saves to the user's DB row ---
    const post = await fetch(`${baseUrl}/api/user/git-config`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitName: 'Ada Lovelace', gitEmail: 'ada@example.com' }),
    });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), {
      success: true,
      gitName: 'Ada Lovelace',
      gitEmail: 'ada@example.com',
    });

    // --- GET after saving: reads back what was just posted ---
    const after = await fetch(`${baseUrl}/api/user/git-config`, { headers: authHeaders });
    assert.equal(after.status, 200);
    assert.deepEqual(await after.json(), {
      success: true,
      gitName: 'Ada Lovelace',
      gitEmail: 'ada@example.com',
    });

    // --- only verifiable with a real `git` on PATH: the POST also applied
    // the identity to the (redirected, throwaway) global git config. ---
    await test('the POST also applies the identity via `git config --global`', { skip: !hasGit }, async () => {
      const [name, email] = await Promise.all([
        spawnAsync('git', ['config', '--global', 'user.name']),
        spawnAsync('git', ['config', '--global', 'user.email']),
      ]);
      assert.equal(name.stdout.trim(), 'Ada Lovelace');
      assert.equal(email.stdout.trim(), 'ada@example.com');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeConnection();
    await rm(tempDir, { recursive: true, force: true });
    await rm(gitHomeDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousGitEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
