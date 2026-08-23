import { describe, expect, it } from 'vitest';

import { readVapidPublicKey } from './useWebPush';

describe('readVapidPublicKey', () => {
  it('rejects a non-OK response before reading it as a success payload', async () => {
    const response = new Response('{"error":"broken"}', {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });

    await expect(readVapidPublicKey(response)).rejects.toThrow('HTTP 500');
  });

  it('rejects malformed JSON and missing public keys with specific errors', async () => {
    await expect(readVapidPublicKey(new Response('<html>bad gateway</html>')))
      .rejects.toThrow('response was invalid');
    await expect(readVapidPublicKey(new Response('{"publicKey":null}')))
      .rejects.toThrow('did not include a public key');
  });

  it('returns a valid public key', async () => {
    await expect(readVapidPublicKey(new Response('{"publicKey":"abc123"}')))
      .resolves.toBe('abc123');
  });
});
