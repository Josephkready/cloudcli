/**
 * Change notification for the `claude-settings` localStorage blob.
 *
 * The blob is a shared bag of user preferences: the settings dialog owns most
 * of it (tool permissions, `projectSortOrder`, `hideCliOriginChats`), the
 * sidebar's "N CLI chats hidden · Show" affordance flips one key, and granting
 * a tool permission from the chat view appends to another. Several unrelated
 * surfaces read it live — the sidebar's project sort order and the CLI-origin
 * filter (which is mounted twice, in the conversation list and the session tab
 * strip).
 *
 * The browser only dispatches `storage` to *other* tabs, never to the tab that
 * wrote the value, so those readers used to run a one-second `setInterval` each
 * to notice same-tab writes (#273). Instead, every writer now calls
 * {@link notifyClaudeSettingsChanged} and every reader subscribes with
 * {@link subscribeToClaudeSettings}, which listens for both the same-tab custom
 * event and the cross-tab `storage` event. Updates land immediately instead of
 * up to a second late, and an idle tab runs no timers at all.
 *
 * This mirrors `CODE_EDITOR_SETTINGS_CHANGED_EVENT`, which the code editor
 * settings already used for exactly the same reason.
 */

/** The single localStorage key this module coordinates. */
export const CLAUDE_SETTINGS_KEY = 'claude-settings';

/** Same-tab notification event, dispatched on `window`. */
export const CLAUDE_SETTINGS_CHANGED_EVENT = 'claudeSettingsChanged';

/**
 * Announces a write to `claude-settings` to same-tab readers.
 *
 * Call this immediately after every `localStorage.setItem(CLAUDE_SETTINGS_KEY,
 * …)`. Nothing polls the key anymore, so a writer that forgets leaves every
 * subscriber showing stale settings until an unrelated write or a reload.
 */
export const notifyClaudeSettingsChanged = (): void => {
  // Guard for the DOM-less `node:test` tier (and any SSR render), where the
  // localStorage write still has to land even though nobody can be listening.
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new Event(CLAUDE_SETTINGS_CHANGED_EVENT));
};

/**
 * Subscribes `onChange` to `claude-settings` writes from this tab (the custom
 * event) and from other tabs (the native `storage` event, filtered to this one
 * key). Returns the unsubscribe function; callers must invoke it on unmount.
 */
export const subscribeToClaudeSettings = (onChange: () => void): (() => void) => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    // A `localStorage.clear()` arrives with `key === null` and drops the blob
    // along with everything else, so it counts as a change too.
    if (event.key === null || event.key === CLAUDE_SETTINGS_KEY) {
      onChange();
    }
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener(CLAUDE_SETTINGS_CHANGED_EVENT, onChange);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(CLAUDE_SETTINGS_CHANGED_EVENT, onChange);
  };
};
