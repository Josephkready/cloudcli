import { useEffect, useState } from 'react';

import { readHideCliOriginChats } from '../components/sidebar/utils/utils';
import { subscribeToClaudeSettings } from '../utils/claudeSettings';

/**
 * Live view of the global "hide CLI-origin chats" preference (#216).
 *
 * The preference lives in the `claude-settings` localStorage blob written by the
 * settings dialog, exactly like `projectSortOrder`. Settings is rendered in the
 * same tab as the lists it affects, so a `storage` event alone would never fire
 * (the browser only dispatches it to *other* tabs). `subscribeToClaudeSettings`
 * covers both directions: the same-tab `claudeSettingsChanged` event every
 * writer dispatches, plus the native cross-tab `storage` event. This replaced a
 * focus-gated one-second poll (#273) — updates are now immediate.
 *
 * Shared by every consumer (sidebar conversation list, per-space session tabs)
 * so they can't disagree about whether CLI sessions are hidden.
 */
export function useHideCliOriginChats(): boolean {
  const [hideCliOriginChats, setHideCliOriginChats] = useState<boolean>(() => readHideCliOriginChats());

  useEffect(() => {
    const load = () => setHideCliOriginChats(readHideCliOriginChats());

    // Re-read on mount: the state initialiser ran before this hook's first
    // paint, but a write between render and effect would otherwise be missed.
    load();

    return subscribeToClaudeSettings(load);
  }, []);

  return hideCliOriginChats;
}
