import webPush from 'web-push';
import { vapidKeysDb } from '../modules/database/repositories/vapid-keys.js';

let cachedKeys = null;

function ensureVapidKeys() {
  if (cachedKeys) return cachedKeys;

  const stored = vapidKeysDb.getVapidKeys();
  if (stored) {
    cachedKeys = stored;
    return cachedKeys;
  }

  const keys = webPush.generateVAPIDKeys();
  vapidKeysDb.createVapidKeys(keys.publicKey, keys.privateKey);
  cachedKeys = keys;
  return cachedKeys;
}

function getPublicKey() {
  return ensureVapidKeys().publicKey;
}

function configureWebPush() {
  const keys = ensureVapidKeys();
  webPush.setVapidDetails(
    'mailto:noreply@cloudcli.local',
    keys.publicKey,
    keys.privateKey
  );
  console.log('Web Push notifications configured');
}

export { ensureVapidKeys, getPublicKey, configureWebPush };
