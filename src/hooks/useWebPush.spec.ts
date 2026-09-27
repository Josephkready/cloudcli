import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();

vi.mock('../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const { ensureSuccessfulPushResponse, readVapidPublicKey, useWebPush } = await import('./useWebPush');

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

describe('useWebPush', () => {
  const originalNotification = (globalThis as unknown as { Notification?: unknown }).Notification;
  const originalServiceWorker = (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;

  let requestPermission: ReturnType<typeof vi.fn>;
  let getSubscription: ReturnType<typeof vi.fn>;
  let subscribeMock: ReturnType<typeof vi.fn>;
  let swReady: Promise<unknown>;

  function installSupportedBrowser({
    permission = 'default' as NotificationPermission,
    existingSubscription = null as unknown,
  } = {}) {
    requestPermission = vi.fn().mockResolvedValue('granted');
    getSubscription = vi.fn().mockResolvedValue(existingSubscription);
    subscribeMock = vi.fn();

    const registration = {
      pushManager: {
        getSubscription,
        subscribe: subscribeMock,
      },
    };
    swReady = Promise.resolve(registration);

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: swReady },
    });

    (globalThis as unknown as { Notification: unknown }).Notification = {
      permission,
      requestPermission,
    };

    return { registration };
  }

  function installUnsupportedBrowser() {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: undefined,
    });
    delete (globalThis as unknown as { Notification?: unknown }).Notification;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    authenticatedFetch.mockReset();
    if (originalServiceWorker === undefined) {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    } else {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: originalServiceWorker,
      });
    }
    if (originalNotification === undefined) {
      delete (globalThis as unknown as { Notification?: unknown }).Notification;
    } else {
      (globalThis as unknown as { Notification: unknown }).Notification = originalNotification;
    }
  });

  it('reports unsupported when serviceWorker/Notification are unavailable', () => {
    installUnsupportedBrowser();
    const { result } = renderHook(() => useWebPush());
    expect(result.current.permission).toBe('unsupported');
    expect(result.current.isSubscribed).toBe(false);
  });

  it('subscribe() is a no-op returning false when unsupported', async () => {
    installUnsupportedBrowser();
    const { result } = renderHook(() => useWebPush());
    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.subscribe();
    });
    expect(outcome).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it('detects an existing subscription on mount', async () => {
    installSupportedBrowser({ permission: 'granted', existingSubscription: { endpoint: 'e' } });
    const { result } = renderHook(() => useWebPush());
    await waitFor(() => expect(result.current.isSubscribed).toBe(true));
  });

  it('reports not-subscribed on mount when there is no existing subscription', async () => {
    installSupportedBrowser({ permission: 'granted', existingSubscription: null });
    const { result } = renderHook(() => useWebPush());
    await waitFor(() => expect(result.current.permission).toBe('granted'));
    expect(result.current.isSubscribed).toBe(false);
  });

  it('subscribe() stops after permission is denied, without calling the API', async () => {
    installSupportedBrowser({ permission: 'default' });
    requestPermission.mockResolvedValue('denied');
    const { result } = renderHook(() => useWebPush());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.subscribe();
    });

    expect(outcome).toBe(false);
    expect(result.current.permission).toBe('denied');
    expect(result.current.isSubscribed).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('subscribe() succeeds end-to-end when permission is granted', async () => {
    installSupportedBrowser({ permission: 'default' });
    requestPermission.mockResolvedValue('granted');

    authenticatedFetch.mockImplementation((url: string) => {
      if (url === '/api/settings/push/vapid-public-key') {
        return Promise.resolve(new Response(JSON.stringify({ publicKey: 'AAAA' })));
      }
      if (url === '/api/settings/push/subscribe') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    const fakeSubscription = { toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }) };
    subscribeMock.mockResolvedValue(fakeSubscription);
    // The initial mount effect (permission: 'default') sees no subscription yet;
    // once subscribe() flips permission to 'granted' the effect re-runs and a
    // real browser's getSubscription() would now return the new subscription.
    getSubscription.mockResolvedValueOnce(null).mockResolvedValue(fakeSubscription);

    const { result } = renderHook(() => useWebPush());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.subscribe();
    });

    expect(outcome).toBe(true);
    await waitFor(() => expect(result.current.isSubscribed).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(subscribeMock).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/settings/push/subscribe', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }),
    }));
  });

  it('subscribe() surfaces a failure when fetching the VAPID key fails', async () => {
    installSupportedBrowser({ permission: 'default' });
    requestPermission.mockResolvedValue('granted');
    authenticatedFetch.mockResolvedValue(new Response(null, { status: 500 }));

    const { result } = renderHook(() => useWebPush());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.subscribe();
    });

    expect(outcome).toBe(false);
    expect(result.current.isSubscribed).toBe(false);
    expect(result.current.error).toMatch(/HTTP 500/);
    expect(result.current.isLoading).toBe(false);
  });

  it('subscribe() surfaces a failure when the push manager subscribe call rejects', async () => {
    installSupportedBrowser({ permission: 'default' });
    requestPermission.mockResolvedValue('granted');
    authenticatedFetch.mockResolvedValue(new Response(JSON.stringify({ publicKey: 'AAAA' })));
    subscribeMock.mockRejectedValue(new Error('permission dismissed'));

    const { result } = renderHook(() => useWebPush());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.subscribe();
    });

    expect(outcome).toBe(false);
    expect(result.current.error).toBe('permission dismissed');
    expect(result.current.isSubscribed).toBe(false);
  });

  it('subscribe() surfaces a failure when saving the subscription to the backend fails', async () => {
    installSupportedBrowser({ permission: 'default' });
    requestPermission.mockResolvedValue('granted');
    authenticatedFetch.mockImplementation((url: string) => {
      if (url === '/api/settings/push/vapid-public-key') {
        return Promise.resolve(new Response(JSON.stringify({ publicKey: 'AAAA' })));
      }
      return Promise.resolve(new Response(null, { status: 502 }));
    });
    subscribeMock.mockResolvedValue({ toJSON: () => ({ endpoint: 'e', keys: {} }) });

    const { result } = renderHook(() => useWebPush());

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.subscribe();
    });

    expect(outcome).toBe(false);
    expect(result.current.error).toMatch(/Could not save the push subscription \(HTTP 502\)/);
  });

  it('unsubscribe() removes an existing subscription and calls the backend', async () => {
    const unsubscribeMock = vi.fn().mockResolvedValue(true);
    installSupportedBrowser({
      permission: 'granted',
      existingSubscription: { endpoint: 'https://push.example/1', unsubscribe: unsubscribeMock },
    });
    authenticatedFetch.mockResolvedValue(new Response(null, { status: 200 }));

    const { result } = renderHook(() => useWebPush());
    await waitFor(() => expect(result.current.isSubscribed).toBe(true));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.unsubscribe();
    });

    expect(outcome).toBe(true);
    expect(result.current.isSubscribed).toBe(false);
    expect(result.current.error).toBeNull();
    expect(unsubscribeMock).toHaveBeenCalled();
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/settings/push/unsubscribe', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ endpoint: 'https://push.example/1' }),
    }));
  });

  it('unsubscribe() is a no-op success when there is no active subscription', async () => {
    installSupportedBrowser({ permission: 'granted', existingSubscription: null });
    const { result } = renderHook(() => useWebPush());
    await waitFor(() => expect(result.current.permission).toBe('granted'));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.unsubscribe();
    });

    expect(outcome).toBe(true);
    expect(result.current.isSubscribed).toBe(false);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('unsubscribe() surfaces a failure when the backend rejects the removal', async () => {
    const unsubscribeMock = vi.fn();
    installSupportedBrowser({
      permission: 'granted',
      existingSubscription: { endpoint: 'e', unsubscribe: unsubscribeMock },
    });
    authenticatedFetch.mockResolvedValue(new Response(null, { status: 503 }));

    const { result } = renderHook(() => useWebPush());
    await waitFor(() => expect(result.current.isSubscribed).toBe(true));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.unsubscribe();
    });

    expect(outcome).toBe(false);
    expect(result.current.error).toMatch(/Could not remove the push subscription \(HTTP 503\)/);
    expect(unsubscribeMock).not.toHaveBeenCalled();
    expect(result.current.isSubscribed).toBe(true);
  });

  it('does not produce an unhandled rejection when the mount effect\'s getSubscription() rejects', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      installSupportedBrowser({ permission: 'granted' });
      getSubscription.mockRejectedValue(new Error('boom'));

      const { result } = renderHook(() => useWebPush());
      await act(async () => {
        await swReady;
        // Flush the microtask queue so the inner getSubscription() rejection
        // has a chance to surface (and, on the old code, escape unhandled).
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.isSubscribed).toBe(false);
      expect(result.current.error).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
  });

  it('unsubscribe() surfaces a generic failure message for non-Error rejections', async () => {
    installSupportedBrowser({ permission: 'granted' });
    // Let the mount effect's own getSubscription() call resolve cleanly and
    // only reject on the later call made from unsubscribe().
    getSubscription.mockResolvedValueOnce(null).mockRejectedValue('boom');

    const { result } = renderHook(() => useWebPush());
    await waitFor(() => expect(result.current.permission).toBe('granted'));

    let outcome: boolean | undefined;
    await act(async () => {
      outcome = await result.current.unsubscribe();
    });

    expect(outcome).toBe(false);
    expect(result.current.error).toBe('Push unsubscribe failed.');
  });
});
