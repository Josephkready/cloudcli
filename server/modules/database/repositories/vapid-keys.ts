/**
 * VAPID keys repository.
 *
 * Stores and retrieves the Web Push VAPID key pair.
 */

import { getConnection } from '@/modules/database/connection.js';

type VapidKeyRow = {
  public_key: string;
  private_key: string;
};

type VapidKeyPair = {
  publicKey: string;
  privateKey: string;
};

export const vapidKeysDb = {
  /** Returns the latest stored VAPID key pair, or null when unset. */
  getVapidKeys(): VapidKeyPair | null {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1'
      )
      .get() as VapidKeyRow | undefined;

    if (!row) return null;
    return {
      publicKey: row.public_key,
      privateKey: row.private_key,
    };
  },

  /** Persists a new VAPID key pair. */
  createVapidKeys(publicKey: string, privateKey: string): void {
    const db = getConnection();
    db.prepare(
      'INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)'
    ).run(publicKey, privateKey);
  },
};
