import { useEffect, useState } from 'react';

import { readHideCliOriginChats } from '../components/sidebar/utils/utils';

/**
 * Live view of the global "hide CLI-origin chats" preference (#216).
 *
 * The preference lives in the `claude-settings` localStorage blob written by the
 * settings dialog, exactly like `projectSortOrder`. Settings is rendered in the
 * same tab as the lists it affects, so a `storage` event alone would never fire
 * (the browser only dispatches it to *other* tabs) — hence the same
 * focus-gated one-second poll `useSidebarController` already uses for the sort
 * order, plus the `storage` listener for other tabs.
 *
 * Shared by every consumer (sidebar conversation list, per-space session tabs)
 * so they can't disagree about whether CLI sessions are hidden.
 */
export function useHideCliOriginChats(): boolean {
  const [hideCliOriginChats, setHideCliOriginChats] = useState<boolean>(() => readHideCliOriginChats());

  useEffect(() => {
    const load = () => setHideCliOriginChats(readHideCliOriginChats());

    load();

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'claude-settings') {
        load();
      }
    };

    window.addEventListener('storage', handleStorageChange);

    const interval = setInterval(() => {
      if (document.hasFocus()) {
        load();
      }
    }, 1000);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      clearInterval(interval);
    };
  }, []);

  return hideCliOriginChats;
}
