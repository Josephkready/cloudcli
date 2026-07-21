import { useEffect, useReducer, useRef } from 'react';

import {
  SYNC_EVENT,
  readInitialPreferences,
  reducer,
} from './useUiPreferences.pure';
import type {
  SyncEventDetail,
  UiPreferenceKey,
  UiPreferences,
} from './useUiPreferences.pure';

export type { UiPreferenceKey, UiPreferences } from './useUiPreferences.pure';

export function useUiPreferences(storageKey = 'uiPreferences') {
  const instanceIdRef = useRef(`ui-preferences-${Math.random().toString(36).slice(2)}`);
  const [state, dispatch] = useReducer(
    reducer,
    storageKey,
    readInitialPreferences
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    localStorage.setItem(storageKey, JSON.stringify(state));

    window.dispatchEvent(
      new CustomEvent<SyncEventDetail>(SYNC_EVENT, {
        detail: {
          storageKey,
          sourceId: instanceIdRef.current,
          value: state,
        },
      })
    );
  }, [state, storageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const applyExternalUpdate = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return;
      }
      dispatch({ type: 'set_many', value: value as Partial<Record<UiPreferenceKey, unknown>> });
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key !== storageKey || event.newValue === null) {
        return;
      }

      try {
        const parsed = JSON.parse(event.newValue);
        applyExternalUpdate(parsed);
      } catch {
        // Ignore malformed storage updates.
      }
    };

    const handleSyncEvent = (event: Event) => {
      const syncEvent = event as CustomEvent<SyncEventDetail>;
      const detail = syncEvent.detail;
      if (!detail || detail.storageKey !== storageKey || detail.sourceId === instanceIdRef.current) {
        return;
      }

      applyExternalUpdate(detail.value);
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener(SYNC_EVENT, handleSyncEvent as EventListener);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener(SYNC_EVENT, handleSyncEvent as EventListener);
    };
  }, [storageKey]);

  const setPreference = (key: UiPreferenceKey, value: unknown) => {
    dispatch({ type: 'set', key, value });
  };

  const setPreferences = (value: Partial<Record<UiPreferenceKey, unknown>>) => {
    dispatch({ type: 'set_many', value });
  };

  const resetPreferences = (value?: Partial<UiPreferences>) => {
    dispatch({ type: 'reset', value });
  };

  return {
    preferences: state,
    setPreference,
    setPreferences,
    resetPreferences,
    dispatch,
  };
}
