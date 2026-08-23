import { useEffect, useRef } from 'react';

import { safeLocalStorage } from '../components/chat/utils/chatStorage';

import {
  SHARED_TEXT_KEY,
  hasLaunchIntent,
  parseLaunchParams,
  stripLaunchParams,
  type LaunchIntent,
} from './launchParams';

/**
 * Acts on the URL an installed app was launched with (issue #370).
 *
 * The manifest's `shortcuts` and `share_target` both start the app at a URL
 * rather than calling into it, so this reads the URL once on mount, does what it
 * asks, and removes the parameters.
 *
 * Stripping matters as much as acting: these are one-shot instructions, and
 * leaving them in the address bar means a reload silently repeats them —
 * resetting a conversation the user has moved on from, or re-inserting a share
 * they already sent. `history.replaceState` rather than a router navigation, so
 * the cleanup leaves no entry to go Back into.
 *
 * @param startNewConversation Fires the shortcut's action, or `null` while the
 *   app has nothing to start a conversation in yet. A cold launch reaches this
 *   before the project list has loaded, so the action is held rather than
 *   dropped — a shortcut that silently did nothing on a cold start would be
 *   worse than not shipping one.
 */
export function useLaunchIntent(startNewConversation: (() => void) | null): void {
  const intentRef = useRef<LaunchIntent | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    const intent = parseLaunchParams(window.location.search);
    intentRef.current = intent;
    if (!hasLaunchIntent(intent)) {
      return;
    }

    if (intent.sharedText) {
      // Parked rather than applied: a share can arrive before any project is
      // selected, and the composer's draft is per project. The composer claims
      // it once there is somewhere to put it.
      safeLocalStorage.setItem(SHARED_TEXT_KEY, intent.sharedText);
    }

    window.history.replaceState(
      window.history.state,
      '',
      stripLaunchParams(window.location.href),
    );
    // Mount only. Re-running would re-fire the intent, which is what the strip
    // above exists to prevent.
  }, []);

  useEffect(() => {
    if (startedRef.current || !startNewConversation) {
      return;
    }
    if (!intentRef.current?.newConversation) {
      return;
    }
    // Latched, because the callback's identity changes on every render once a
    // project exists; without this the shortcut would restart the conversation
    // continuously.
    startedRef.current = true;
    startNewConversation();
  }, [startNewConversation]);
}
