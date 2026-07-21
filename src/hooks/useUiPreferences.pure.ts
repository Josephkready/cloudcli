/**
 * Pure state logic for `useUiPreferences`: the preference shape, the reducer,
 * the coercion rule, and the initial read from storage.
 *
 * `useUiPreferences` keeps the `useReducer` wiring, the persistence effect and
 * the cross-tab sync listeners; everything that is a plain input → output
 * transition lives here so it can be unit-tested without rendering a hook.
 */

export type UiPreferences = {
  showRawParameters: boolean;
  showThinking: boolean;
  sendByCtrlEnter: boolean;
  sidebarVisible: boolean;
  // Whether the sidebar's Spaces section is expanded. Defaults to collapsed so
  // Conversations owns the vertical space until the user opens Spaces.
  spacesExpanded: boolean;
  voiceEnabled: boolean;
};

export type UiPreferenceKey = keyof UiPreferences;

type SetPreferenceAction = {
  type: 'set';
  key: UiPreferenceKey;
  value: unknown;
};

type SetManyPreferencesAction = {
  type: 'set_many';
  value?: Partial<Record<UiPreferenceKey, unknown>>;
};

type ResetPreferencesAction = {
  type: 'reset';
  value?: Partial<UiPreferences>;
};

export type UiPreferencesAction =
  | SetPreferenceAction
  | SetManyPreferencesAction
  | ResetPreferencesAction;

export const DEFAULTS: UiPreferences = {
  showRawParameters: false,
  showThinking: true,
  sendByCtrlEnter: false,
  sidebarVisible: true,
  spacesExpanded: false,
  voiceEnabled: false,
};

export const PREFERENCE_KEYS = Object.keys(DEFAULTS) as UiPreferenceKey[];
const VALID_KEYS = new Set<UiPreferenceKey>(PREFERENCE_KEYS); // prevents unknown keys from being written

export const SYNC_EVENT = 'ui-preferences:sync';

export type SyncEventDetail = {
  storageKey: string;
  sourceId: string;
  value: Partial<Record<UiPreferenceKey, unknown>>;
};

export const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return fallback;
};

const readLegacyPreference = (key: UiPreferenceKey, fallback: boolean): boolean => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;

    // Supports values written by both JSON.stringify and plain strings.
    const parsed = JSON.parse(raw);
    return parseBoolean(parsed, fallback);
  } catch {
    return fallback;
  }
};

export const readInitialPreferences = (storageKey: string): UiPreferences => {
  if (typeof window === 'undefined') {
    return DEFAULTS;
  }

  try {
    const raw = localStorage.getItem(storageKey);

    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const parsedRecord = parsed as Record<string, unknown>;

        return PREFERENCE_KEYS.reduce((acc, key) => {
          acc[key] = parseBoolean(parsedRecord[key], DEFAULTS[key]);
          return acc;
        }, { ...DEFAULTS });
      }
    }
  } catch {
    // Fall back to legacy keys when unified key is missing or invalid.
  }

  return PREFERENCE_KEYS.reduce((acc, key) => {
    acc[key] = readLegacyPreference(key, DEFAULTS[key]);
    return acc;
  }, { ...DEFAULTS });
};

export function reducer(state: UiPreferences, action: UiPreferencesAction): UiPreferences {
  switch (action.type) {
    case 'set': {
      const { key, value } = action;
      if (!VALID_KEYS.has(key)) {
        return state;
      }

      const nextValue = parseBoolean(value, state[key]);
      if (state[key] === nextValue) {
        return state;
      }

      return { ...state, [key]: nextValue };
    }
    case 'set_many': {
      const updates = action.value || {};
      let changed = false;
      const nextState = { ...state };

      for (const key of PREFERENCE_KEYS) {
        if (!(key in updates)) continue;

        const value = updates[key];
        const nextValue = parseBoolean(value, state[key]);
        if (nextState[key] !== nextValue) {
          nextState[key] = nextValue;
          changed = true;
        }
      }

      return changed ? nextState : state;
    }
    case 'reset':
      return { ...DEFAULTS, ...(action.value || {}) };
    default:
      return state;
  }
}
