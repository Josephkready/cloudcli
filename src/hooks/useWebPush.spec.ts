import { describe, expect, it } from 'vitest';

import { ensureSuccessfulPushResponse, readVapidPublicKey } from './useWebPush';

describe('ensureSuccessfulPushResponse', () => {
  it('rejects failed subscription API responses with their status', () => {
    expect(() => ensureSuccessfulPushResponse(
      new Response(null, { status: 503 }),
      'Could not remove the push subscription',
    )).toThrow('Could not remove the push subscription (HTTP 503).');
  });

  it('accepts successful subscription API responses', () => {
    expect(() => ensureSuccessfulPushResponse(
      new Response(null, { status: 204 }),
      'Could not remove the push subscription',
    )).not.toThrow();
  });
});

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
