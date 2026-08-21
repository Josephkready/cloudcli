/**
 * Hardware/gesture **Back** dismissal for the shared overlay layer (#365).
 *
 * A hand-rolled `fixed inset-0` overlay pushes no history entry, so on a phone
 * the Back gesture — the primary "dismiss anything full-screen" affordance —
 * navigates away from the app instead of closing the overlay, throwing the user
 * out and losing their place.
 *
 * The fix: while an overlay is active it pushes one sentinel history entry; a
 * single shared `popstate` listener closes the topmost overlay when Back pops a
 * sentinel; and an overlay closed by any other means (Esc, backdrop, its own X)
 * pops its own sentinel so a later Back isn't silently swallowed by a stale one.
 *
 * Why one shared listener instead of one per overlay: with the folder picker
 * stacked on the project wizard, a per-overlay listener + a per-overlay cleanup
 * `history.back()` would let one Back (or one programmatic cleanup) close *both*
 * — the classic modal-history double-close. A single listener that only ever
 * touches the top of the stack, plus one `ignoreNextPop` guard around the
 * programmatic back, keeps Back peeling exactly one layer at a time.
 *
 * The URL never changes (pushState with no url argument), so react-router — which
 * only reacts to `popstate` landing on *its own* entries — sees no navigation.
 *
 * Topmost == last registered, the same ordering `overlayLayers.ts` uses for Esc.
 * That holds only when a nested overlay opens in a *later* commit than its parent
 * (React fires child effects before parent effects, so a same-commit nested mount
 * would register child-first and mis-target Back). Today's only nested pair — the
 * folder picker inside the project wizard — opens via a separate click, so it is
 * always a later commit; a future stacked overlay that starts active alongside
 * its parent would need explicit depth ordering here and in `overlayLayers.ts`.
 */

type BackDismissEntry = {
  onDismiss: () => void;
  // Set by the popstate handler right before it fires onDismiss, so the ensuing
  // unregister knows the sentinel is already gone and must not `history.back()`
  // a second time.
  closedByBack: boolean;
};

const stack: BackDismissEntry[] = [];
let listenerBound = false;
// How many of our own cleanup `history.back()`s are still awaiting their
// popstate. A count (not a boolean) so that closing two stacked overlays
// programmatically in the same tick — two queued back()s — is attributed
// correctly instead of letting the second popstate read as a real user Back.
let pendingSelfPops = 0;

function handlePopState(): void {
  // Our own cleanup back() — swallow it and leave the stack alone.
  if (pendingSelfPops > 0) {
    pendingSelfPops -= 1;
    return;
  }
  const top = stack[stack.length - 1];
  if (!top) return;
  top.closedByBack = true;
  top.onDismiss();
}

function ensureListenerBound(): void {
  if (listenerBound || typeof window === 'undefined') return;
  listenerBound = true;
  window.addEventListener('popstate', handlePopState);
}

/**
 * Register an active overlay for Back-to-dismiss. Call on open; call the returned
 * function on close (any close path). `onDismiss` should close the overlay.
 */
export function registerBackDismiss(onDismiss: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  ensureListenerBound();

  const entry: BackDismissEntry = { onDismiss, closedByBack: false };
  stack.push(entry);
  // Carry the current entry's history state onto the sentinel (react-router
  // stamps `{ idx, key, usr }`). If a `navigate()` happens while our sentinel is
  // the top entry, react-router reads `window.history.state.idx` to compute the
  // next index — a marker-only state would leave `idx` undefined and bake `NaN`
  // into a real, permanent history entry. Preserving the fields also keeps the
  // router's `location.key` stable when Back lands on the sentinel.
  window.history.pushState({ ...window.history.state, __overlayBackDismiss: true }, '');

  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;

    const index = stack.indexOf(entry);
    if (index !== -1) {
      stack.splice(index, 1);
    }

    // Closed by something other than Back (Esc, backdrop, an X button, an
    // unmount) → remove the sentinel we pushed so a later Back closes the next
    // overlay (or leaves the app) rather than being wasted on a stale entry.
    if (!entry.closedByBack) {
      pendingSelfPops += 1;
      window.history.back();
    }
  };
}

/** Test-only: clear module state between cases. */
export function __resetBackDismissForTest(): void {
  stack.length = 0;
  pendingSelfPops = 0;
}
