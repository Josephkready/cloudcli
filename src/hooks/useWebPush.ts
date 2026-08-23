import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

type WebPushState = {
  permission: NotificationPermission | 'unsupported';
  isSubscribed: boolean;
  isLoading: boolean;
  error: string | null;
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<boolean>;
};

export function ensureSuccessfulPushResponse(response: Response, action: string): void {
  if (!response.ok) {
    throw new Error(`${action} (HTTP ${response.status}).`);
  }
}

export async function readVapidPublicKey(response: Response): Promise<string> {
  if (!response.ok) {
    throw new Error(`Could not load push notification configuration (HTTP ${response.status}).`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The push notification configuration response was invalid.');
  }
  const publicKey = payload && typeof payload === 'object' && 'publicKey' in payload
    ? (payload as { publicKey?: unknown }).publicKey
    : undefined;
  if (typeof publicKey !== 'string' || publicKey.trim() === '') {
    throw new Error('The push notification configuration did not include a public key.');
  }
  return publicKey;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function useWebPush(): WebPushState {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (
      typeof window === 'undefined'
      || !('Notification' in window)
      || !('serviceWorker' in navigator)
    ) {
      return 'unsupported';
    }
    return Notification.permission;
  });
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check existing subscription on mount
  useEffect(() => {
    if (permission === 'unsupported') return;

    navigator.serviceWorker.ready.then((registration) => {
      registration.pushManager.getSubscription().then((sub) => {
        setIsSubscribed(sub !== null);
      });
    }).catch(() => {
      // SW not ready yet
    });
  }, [permission]);

  const subscribe = useCallback(async () => {
    if (permission === 'unsupported') return false;
    setIsLoading(true);
    setError(null);

    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') return false;

      const keyRes = await authenticatedFetch('/api/settings/push/vapid-public-key');
      const publicKey = await readVapidPublicKey(keyRes);

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });

      const subJson = subscription.toJSON();
      const subscribeResponse = await authenticatedFetch('/api/settings/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: subJson.keys,
        }),
      });
      ensureSuccessfulPushResponse(subscribeResponse, 'Could not save the push subscription');

      setIsSubscribed(true);
      return true;
    } catch (err) {
      console.error('Push subscribe failed:', err);
      setError(err instanceof Error ? err.message : 'Push subscription failed.');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [permission]);

  const unsubscribe = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        const unsubscribeResponse = await authenticatedFetch('/api/settings/push/unsubscribe', {
          method: 'POST',
          body: JSON.stringify({ endpoint }),
        });
        ensureSuccessfulPushResponse(unsubscribeResponse, 'Could not remove the push subscription');
        await subscription.unsubscribe();
      }
      setIsSubscribed(false);
      return true;
    } catch (err) {
      console.error('Push unsubscribe failed:', err);
      setError(err instanceof Error ? err.message : 'Push unsubscribe failed.');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { permission, isSubscribed, isLoading, error, subscribe, unsubscribe };
}
