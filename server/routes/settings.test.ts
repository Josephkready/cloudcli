import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';

import settingsRoutes from './settings.js';

type JsonResult = { status: number; body: any };

async function withSettingsServer(
  runTest: (
    request: (method: string, urlPath: string, body?: unknown) => Promise<JsonResult>,
  ) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousAuthDisabled = process.env.VITE_AUTH_DISABLED;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'settings-route-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.VITE_AUTH_DISABLED = 'true';
  await initializeDatabase();
  const user = userDb.getFirstUser();
  if (!user) {
    throw new Error('expected a seeded default user in auth-disabled mode');
  }

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: user.id };
    next();
  });
  app.use('/api/settings', settingsRoutes);

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const request = async (method: string, urlPath: string, body?: unknown): Promise<JsonResult> => {
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };

  try {
    await runTest(request);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousAuthDisabled === undefined) delete process.env.VITE_AUTH_DISABLED;
    else process.env.VITE_AUTH_DISABLED = previousAuthDisabled;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('API keys: create, list (masked), toggle, and delete', async () => {
  await withSettingsServer(async (request) => {
    const created = await request('POST', '/api/settings/api-keys', { keyName: 'my key' });
    assert.equal(created.status, 200);
    assert.equal(created.body.success, true);
    const keyId = created.body.apiKey.id;
    assert.match(created.body.apiKey.apiKey, /^ck_/);

    const list = await request('GET', '/api/settings/api-keys');
    assert.equal(list.status, 200);
    assert.equal(list.body.apiKeys.length, 1);
    // Masked in the list response — only a short prefix, not the raw key.
    assert.match(list.body.apiKeys[0].api_key, /^ck_.{7}\.\.\.$/);

    const toggled = await request('PATCH', `/api/settings/api-keys/${keyId}/toggle`, { isActive: false });
    assert.equal(toggled.status, 200);
    assert.equal(toggled.body.success, true);

    const badToggle = await request('PATCH', `/api/settings/api-keys/${keyId}/toggle`, { isActive: 'nope' });
    assert.equal(badToggle.status, 400);

    const missingToggle = await request('PATCH', '/api/settings/api-keys/999999/toggle', { isActive: true });
    assert.equal(missingToggle.status, 404);

    const deleted = await request('DELETE', `/api/settings/api-keys/${keyId}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.success, true);

    const missingDelete = await request('DELETE', `/api/settings/api-keys/${keyId}`);
    assert.equal(missingDelete.status, 404);
  });
});

test('API keys: rejects a missing/blank key name', async () => {
  await withSettingsServer(async (request) => {
    const empty = await request('POST', '/api/settings/api-keys', {});
    assert.equal(empty.status, 400);

    const blank = await request('POST', '/api/settings/api-keys', { keyName: '   ' });
    assert.equal(blank.status, 400);
  });
});

test('Credentials: create, list, filter by type, toggle, and delete', async () => {
  await withSettingsServer(async (request) => {
    const created = await request('POST', '/api/settings/credentials', {
      credentialName: 'gh token',
      credentialType: 'github_token',
      credentialValue: 'secret-value',
      description: 'personal token',
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.success, true);
    const credentialId = created.body.credential.id;
    // The raw value must never come back in the response.
    assert.equal(created.body.credential.credentialValue, undefined);

    const list = await request('GET', '/api/settings/credentials');
    assert.equal(list.body.credentials.length, 1);
    assert.equal(list.body.credentials[0].credential_value, undefined);

    const filtered = await request('GET', '/api/settings/credentials?type=github_token');
    assert.equal(filtered.body.credentials.length, 1);
    const filteredMiss = await request('GET', '/api/settings/credentials?type=gitlab_token');
    assert.equal(filteredMiss.body.credentials.length, 0);

    const toggled = await request('PATCH', `/api/settings/credentials/${credentialId}/toggle`, { isActive: false });
    assert.equal(toggled.status, 200);

    const badToggle = await request('PATCH', `/api/settings/credentials/${credentialId}/toggle`, {});
    assert.equal(badToggle.status, 400);

    const missingToggle = await request('PATCH', '/api/settings/credentials/999999/toggle', { isActive: true });
    assert.equal(missingToggle.status, 404);

    const deleted = await request('DELETE', `/api/settings/credentials/${credentialId}`);
    assert.equal(deleted.status, 200);

    const missingDelete = await request('DELETE', `/api/settings/credentials/${credentialId}`);
    assert.equal(missingDelete.status, 404);
  });
});

test('Credentials: rejects missing name/type/value', async () => {
  await withSettingsServer(async (request) => {
    const noName = await request('POST', '/api/settings/credentials', {
      credentialType: 't',
      credentialValue: 'v',
    });
    assert.equal(noName.status, 400);

    const noType = await request('POST', '/api/settings/credentials', {
      credentialName: 'n',
      credentialValue: 'v',
    });
    assert.equal(noType.status, 400);

    const noValue = await request('POST', '/api/settings/credentials', {
      credentialName: 'n',
      credentialType: 't',
    });
    assert.equal(noValue.status, 400);
  });
});

test('Notification preferences: reads defaults then persists an update', async () => {
  await withSettingsServer(async (request) => {
    const initial = await request('GET', '/api/settings/notification-preferences');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.preferences.channels.webPush, false);

    const updated = await request('PUT', '/api/settings/notification-preferences', {
      channels: { inApp: true, webPush: true, sound: false },
      events: { actionRequired: false, stop: true, error: true },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.preferences.channels.webPush, true);

    const reread = await request('GET', '/api/settings/notification-preferences');
    assert.equal(reread.body.preferences.channels.webPush, true);
    assert.equal(reread.body.preferences.events.actionRequired, false);
  });
});

test('Push: returns a VAPID public key', async () => {
  await withSettingsServer(async (request) => {
    const result = await request('GET', '/api/settings/push/vapid-public-key');
    assert.equal(result.status, 200);
    assert.equal(typeof result.body.publicKey, 'string');
    assert.ok(result.body.publicKey.length > 0);
  });
});

test('Push: subscribe validates fields, flips webPush on, and unsubscribe flips it back off', async () => {
  await withSettingsServer(async (request) => {
    const missingFields = await request('POST', '/api/settings/push/subscribe', { endpoint: 'https://example.com/push' });
    assert.equal(missingFields.status, 400);

    const subscribed = await request('POST', '/api/settings/push/subscribe', {
      endpoint: 'https://example.com/push/abc',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    });
    assert.equal(subscribed.status, 200);
    assert.equal(subscribed.body.success, true);

    const prefsAfterSubscribe = await request('GET', '/api/settings/notification-preferences');
    assert.equal(prefsAfterSubscribe.body.preferences.channels.webPush, true);

    const missingEndpoint = await request('POST', '/api/settings/push/unsubscribe', {});
    assert.equal(missingEndpoint.status, 400);

    const unsubscribed = await request('POST', '/api/settings/push/unsubscribe', {
      endpoint: 'https://example.com/push/abc',
    });
    assert.equal(unsubscribed.status, 200);
    assert.equal(unsubscribed.body.success, true);

    const prefsAfterUnsubscribe = await request('GET', '/api/settings/notification-preferences');
    assert.equal(prefsAfterUnsubscribe.body.preferences.channels.webPush, false);
  });
});
