import webPush from 'web-push';
import { vapidKeysDb } from '../modules/database/repositories/vapid-keys.js';

// Apple's push service (web.push.apple.com) rejects a VAPID JWT whose `sub`
// claim is a non-routable contact such as `mailto:noreply@cloudcli.local`,
// answering every send with 403 BadJwtToken (#496). Default to a real origin.
const DEFAULT_VAPID_SUBJECT = 'https://thedante.net';

function isNonRoutableHost(host) {
  const normalized = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) return true;
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'local' ||
    normalized.endsWith('.local')
  );
}

/**
 * Resolve the VAPID `sub` claim from VAPID_SUBJECT, falling back to the
 * default when unset or invalid. Valid: an https: URL or a mailto: address
 * whose host is not `localhost` or a `.local` name.
 *
 * @param {string | undefined} raw
 * @returns {string}
 */
function resolveVapidSubject(raw = process.env.VAPID_SUBJECT) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return DEFAULT_VAPID_SUBJECT;

  let host = null;
  if (/^mailto:/i.test(value)) {
    const address = value.slice('mailto:'.length);
    const at = address.lastIndexOf('@');
    if (at > 0 && at < address.length - 1) {
      host = address.slice(at + 1);
    }
  } else {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:') host = url.hostname;
    } catch {
      host = null;
    }
  }

  if (host === null || isNonRoutableHost(host)) {
    console.warn(
      `[web-push] Ignoring invalid VAPID_SUBJECT "${value}" (must be an https: URL or mailto: ` +
        `address on a public host). Using ${DEFAULT_VAPID_SUBJECT}.`
    );
    return DEFAULT_VAPID_SUBJECT;
  }
  return value;
}

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
  const subject = resolveVapidSubject();
  webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  console.log(`Web Push notifications configured (VAPID subject: ${subject})`);
}

export { DEFAULT_VAPID_SUBJECT, resolveVapidSubject, ensureVapidKeys, getPublicKey, configureWebPush };
