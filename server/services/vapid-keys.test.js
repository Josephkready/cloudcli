import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import webPush from 'web-push';

import { closeConnection, initializeDatabase } from '../modules/database/index.js';
import { vapidKeysDb } from '../modules/database/repositories/vapid-keys.js';

import { DEFAULT_VAPID_SUBJECT, configureWebPush, resolveVapidSubject } from './vapid-keys.js';

function captureWarnings(run) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return { value: run(), warnings };
  } finally {
    console.warn = original;
  }
}

test('VAPID subject defaults to https://thedante.net when unset or blank', () => {
  assert.equal(DEFAULT_VAPID_SUBJECT, 'https://thedante.net');
  for (const raw of [undefined, '', '   ']) {
    const { value, warnings } = captureWarnings(() => resolveVapidSubject(raw));
    assert.equal(value, DEFAULT_VAPID_SUBJECT);
    assert.equal(warnings.length, 0);
  }
});

test('VAPID subject reads process.env.VAPID_SUBJECT by default', () => {
  const previous = process.env.VAPID_SUBJECT;
  process.env.VAPID_SUBJECT = 'https://example.com';
  try {
    assert.equal(resolveVapidSubject(), 'https://example.com');
  } finally {
    if (previous === undefined) delete process.env.VAPID_SUBJECT;
    else process.env.VAPID_SUBJECT = previous;
  }
});

test('VAPID subject accepts https URLs and public mailto addresses', () => {
  for (const raw of ['https://example.com', 'https://push.example.org/contact', 'mailto:ops@example.com']) {
    const { value, warnings } = captureWarnings(() => resolveVapidSubject(raw));
    assert.equal(value, raw);
    assert.equal(warnings.length, 0);
  }
  assert.equal(resolveVapidSubject('  https://example.com  '), 'https://example.com');
});

test('VAPID subject rejects .local / localhost hosts and bad schemes (#496)', () => {
  const invalid = [
    'mailto:noreply@cloudcli.local',
    'mailto:noreply@CLOUDCLI.LOCAL.',
    'mailto:admin@localhost',
    'https://localhost',
    'https://localhost:3001',
    'https://app.localhost',
    'https://cloudcli.local',
    'https://local',
    'mailto:x@local',
    'http://example.com',
    'example.com',
    'mailto:',
    'mailto:no-at-sign',
    'ftp://example.com',
  ];
  for (const raw of invalid) {
    const { value, warnings } = captureWarnings(() => resolveVapidSubject(raw));
    assert.equal(value, DEFAULT_VAPID_SUBJECT, `expected fallback for ${raw}`);
    assert.equal(warnings.length, 1, `expected a warning for ${raw}`);
  }
});

test('configureWebPush passes the resolved subject and the stored keys to web-push', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousSubject = process.env.VAPID_SUBJECT;
  const originalSetVapidDetails = webPush.setVapidDetails;
  const originalLog = console.log;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'vapid-subject-'));
  const calls = [];

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  webPush.setVapidDetails = (...args) => calls.push(args);
  console.log = () => {};

  try {
    // Existing keys must be reused untouched, or live subscriptions break.
    const stored = webPush.generateVAPIDKeys();
    vapidKeysDb.createVapidKeys(stored.publicKey, stored.privateKey);
    process.env.VAPID_SUBJECT = 'mailto:noreply@cloudcli.local';

    configureWebPush();

    assert.deepEqual(calls, [[DEFAULT_VAPID_SUBJECT, stored.publicKey, stored.privateKey]]);
  } finally {
    webPush.setVapidDetails = originalSetVapidDetails;
    console.log = originalLog;
    if (previousSubject === undefined) delete process.env.VAPID_SUBJECT;
    else process.env.VAPID_SUBJECT = previousSubject;
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
