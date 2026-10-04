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

import {
  describeEndpoint,
  describeRejectionBody,
  notifyRunFailed,
  notifyRunStopped,
} from './notification-orchestrator.service.js';

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

const APPLE_ENDPOINT = 'https://web.push.apple.com/QSECRETTOKENabcdefghijklmnopqrstuvwxyz';
const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/GONETOKEN0123456789';

let rejectionRun = 0;

/**
 * Save one subscription per entry of `outcomes` (endpoint -> rejection, or null
 * for success), fire one notification, and report what was logged and kept.
 */
async function sendWithOutcomes(outcomes) {
  const originalSendNotification = webPush.sendNotification;
  const originalConsoleError = console.error;
  const errors = [];
  // Unique per call: the orchestrator dedupes identical events within 20s.
  rejectionRun += 1;
  const sessionId = `app-session-reject-${rejectionRun}`;

  webPush.sendNotification = async (subscription) => {
    const rejection = outcomes[subscription.endpoint];
    if (rejection) throw rejection;
    return {};
  };
  console.error = (...args) => errors.push(args.join(' '));

  try {
    let remaining;
    await withIsolatedDatabase(async () => {
      const user = userDb.createUser(`reject-user-${rejectionRun}`, 'hash');
      const userId = Number(user.id);

      notificationPreferencesDb.updatePreferences(userId, {
        channels: { webPush: true },
        events: { actionRequired: true, stop: true, error: true },
      });
      for (const endpoint of Object.keys(outcomes)) {
        pushSubscriptionsDb.saveSubscription(userId, endpoint, 'p256dh-secret', 'auth-secret');
      }
      sessionsDb.createAppSession(sessionId, 'claude', '/workspace/demo');

      notifyRunStopped({
        userId,
        provider: 'claude',
        sessionId,
        stopReason: 'completed',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      remaining = pushSubscriptionsDb.getSubscriptions(userId).map((sub) => sub.endpoint);
    });
    return { errors, remaining };
  } finally {
    console.error = originalConsoleError;
    webPush.sendNotification = originalSendNotification;
  }
}

function assertNoSecrets(line) {
  assert.ok(!line.includes('QSECRETTOKEN'), 'endpoint path must not be logged');
  assert.ok(!line.includes('GONETOKEN'), 'endpoint path must not be logged');
  assert.ok(!line.includes('p256dh-secret'));
  assert.ok(!line.includes('auth-secret'));
}

test('non-410/404 push rejections are logged with status and body, not secrets (#496)', async () => {
  const { errors, remaining } = await sendWithOutcomes({
    [APPLE_ENDPOINT]: pushError(403, '{"reason":"BadJwtToken"}'),
  });

  assert.deepEqual(remaining, [APPLE_ENDPOINT], 'a 403 must not delete the subscription');
  assert.equal(errors.length, 1);
  const [line] = errors;
  assert.match(line, /status=403/);
  assert.match(line, /BadJwtToken/);
  assert.match(line, /https:\/\/web\.push\.apple\.com/);
  assertNoSecrets(line);
});

test('410 push rejections remove the subscription without logging an error', async () => {
  const { errors, remaining } = await sendWithOutcomes({ [FCM_ENDPOINT]: pushError(410, 'gone') });
  assert.deepEqual(remaining, []);
  assert.equal(errors.length, 0);
});

test('each subscription is handled by its own outcome when a user has several', async () => {
  const { errors, remaining } = await sendWithOutcomes({
    [APPLE_ENDPOINT]: pushError(403, '{"reason":"BadJwtToken"}'),
    [FCM_ENDPOINT]: pushError(404, 'not found'),
    'https://updates.push.services.mozilla.com/wpush/v2/OKTOKEN': null,
  });

  assert.deepEqual(
    [...remaining].sort(),
    [APPLE_ENDPOINT, 'https://updates.push.services.mozilla.com/wpush/v2/OKTOKEN'].sort(),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /web\.push\.apple\.com/);
  assert.match(errors[0], /status=403/);
  assertNoSecrets(errors[0]);
});

test('describeEndpoint keeps only the origin and tolerates garbage', () => {
  assert.equal(describeEndpoint(APPLE_ENDPOINT), 'https://web.push.apple.com');
  assert.equal(describeEndpoint('not a url'), '<invalid endpoint>');
  assert.equal(describeEndpoint(undefined), '<invalid endpoint>');
});

test('describeRejectionBody handles string, object, message-only, empty and long bodies', () => {
  assert.equal(describeRejectionBody({ body: ' {"reason":"BadJwtToken"} ' }), '{"reason":"BadJwtToken"}');
  assert.equal(describeRejectionBody({ body: { reason: 'BadJwtToken' } }), '{"reason":"BadJwtToken"}');
  assert.equal(describeRejectionBody(new Error('socket hang up')), 'socket hang up');
  assert.equal(describeRejectionBody({ body: '' }), '<empty>');
  assert.equal(describeRejectionBody(undefined), '<empty>');

  const long = describeRejectionBody({ body: 'x'.repeat(500) });
  assert.equal(long, `${'x'.repeat(300)}...`);

  const circular = {};
  circular.self = circular;
  assert.equal(describeRejectionBody({ body: circular }), '[object Object]');
});
