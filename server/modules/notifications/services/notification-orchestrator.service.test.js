import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import webPush from 'web-push';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionsDb,
  userDb,
} from '../../database/index.js';
import { markShutdownDraining, resetShutdownDrainingForTests } from '../../../shared/shutdown-drain.js';

import { notifyRunFailed, notifyRunStopped } from './notification-orchestrator.service.js';

async function withIsolatedDatabase(runTest) {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('push payload uses the app session id when notified with a provider session id', async () => {
  const originalSendNotification = webPush.sendNotification;
  const sentPayloads = [];

  webPush.sendNotification = async (_subscription, payload) => {
    sentPayloads.push(JSON.parse(payload));
    return {};
  };

  try {
    await withIsolatedDatabase(async () => {
      const user = userDb.createUser('notify-user', 'hash');
      const userId = Number(user.id);

      notificationPreferencesDb.updatePreferences(userId, {
        channels: { webPush: true },
        events: { actionRequired: true, stop: true, error: true },
      });
      pushSubscriptionsDb.saveSubscription(userId, 'https://example.test/push', 'p256dh', 'auth');
      sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
      sessionsDb.assignProviderSessionId('app-session-1', 'claude-native-1');

      notifyRunStopped({
        userId,
        provider: 'claude',
        sessionId: 'claude-native-1',
        stopReason: 'completed',
      });

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(sentPayloads.length, 1);
      assert.equal(sentPayloads[0]?.data?.sessionId, 'app-session-1');
      assert.match(sentPayloads[0]?.data?.tag, /app-session-1/);
    });
  } finally {
    webPush.sendNotification = originalSendNotification;
  }
});

test('no "run failed" push while the server is shutting down (#535)', async () => {
  const originalSendNotification = webPush.sendNotification;
  const sentPayloads = [];

  webPush.sendNotification = async (_subscription, payload) => {
    sentPayloads.push(JSON.parse(payload));
    return {};
  };

  try {
    await withIsolatedDatabase(async () => {
      const user = userDb.createUser('drain-user', 'hash');
      const userId = Number(user.id);

      notificationPreferencesDb.updatePreferences(userId, {
        channels: { webPush: true },
        events: { actionRequired: true, stop: true, error: true },
      });
      pushSubscriptionsDb.saveSubscription(userId, 'https://example.test/push', 'p256dh', 'auth');
      sessionsDb.createAppSession('app-session-2', 'claude', '/workspace/demo');

      const failure = {
        userId,
        provider: 'claude',
        sessionId: 'app-session-2',
        error: new Error('Claude Code process exited with code 143'),
      };

      // The deploy's own SIGTERM killed the child: not a failure worth a push.
      markShutdownDraining();
      notifyRunFailed(failure);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sentPayloads.length, 0);

      // Outside a shutdown, a failure still notifies.
      resetShutdownDrainingForTests();
      notifyRunFailed(failure);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sentPayloads.length, 1);
    });
  } finally {
    resetShutdownDrainingForTests();
    webPush.sendNotification = originalSendNotification;
  }
});

function pushError(statusCode, body) {
  const error = new Error('Received unexpected response code');
  error.statusCode = statusCode;
  error.body = body;
  return error;
}

async function sendWithRejection(rejection) {
  const originalSendNotification = webPush.sendNotification;
  const originalConsoleError = console.error;
  const errors = [];
  const endpoint = 'https://web.push.apple.com/QSECRETTOKENabcdefghijklmnopqrstuvwxyz';
  // Unique per call: the orchestrator dedupes identical events within 20s.
  const sessionId = `app-session-reject-${rejection.statusCode}`;

  webPush.sendNotification = async () => {
    throw rejection;
  };
  console.error = (...args) => errors.push(args.join(' '));

  try {
    let remaining;
    await withIsolatedDatabase(async () => {
      const user = userDb.createUser(`reject-user-${rejection.statusCode}`, 'hash');
      const userId = Number(user.id);

      notificationPreferencesDb.updatePreferences(userId, {
        channels: { webPush: true },
        events: { actionRequired: true, stop: true, error: true },
      });
      pushSubscriptionsDb.saveSubscription(userId, endpoint, 'p256dh-secret', 'auth-secret');
      sessionsDb.createAppSession(sessionId, 'claude', '/workspace/demo');

      notifyRunStopped({
        userId,
        provider: 'claude',
        sessionId,
        stopReason: 'completed',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      remaining = pushSubscriptionsDb.getSubscriptions(userId).length;
    });
    return { errors, remaining, endpoint };
  } finally {
    console.error = originalConsoleError;
    webPush.sendNotification = originalSendNotification;
  }
}

test('non-410/404 push rejections are logged with status and body, not secrets (#496)', async () => {
  const { errors, remaining, endpoint } = await sendWithRejection(
    pushError(403, '{"reason":"BadJwtToken"}'),
  );

  assert.equal(remaining, 1, 'a 403 must not delete the subscription');
  assert.equal(errors.length, 1);
  const [line] = errors;
  assert.match(line, /status=403/);
  assert.match(line, /BadJwtToken/);
  assert.match(line, /https:\/\/web\.push\.apple\.com/);
  assert.ok(!line.includes(endpoint), 'full endpoint must not be logged');
  assert.ok(!line.includes('p256dh-secret'));
  assert.ok(!line.includes('auth-secret'));
});

test('410 push rejections remove the subscription without logging an error', async () => {
  const { errors, remaining } = await sendWithRejection(pushError(410, 'gone'));
  assert.equal(remaining, 0);
  assert.equal(errors.length, 0);
});
