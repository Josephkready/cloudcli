- The floating "scroll to bottom" button (`ChatInterface.tsx`, `scrollToBottomAndReset`) appears
  absolutely-positioned above the composer while the user has scrolled up in a non-empty chat; it
  overlaps the top edge of the scrolling message list on purpose. This is not a stray/duplicate
  control and it is not clipping.
- Chat content scrolls in `.chat-messages-pane` (`flex-1 overflow-y-auto`), a sibling of the
  composer (`chat-composer-shell`, `flex-shrink-0`) in the same flex column. The composer stays
  pinned at the bottom of the viewport by that layout, not by `position: fixed`; messages
  disappearing under it as you scroll is the intended behavior, not a z-index bug.
- Code blocks and other block-level code surfaces (bash output, diffs, one-line displays) keep
  `white-space: pre` and scroll horizontally instead of wrapping — this is a deliberate contract,
  not a missing `word-break`. Covered by `e2e/code-block-scroll.spec.ts` (real layout,
  `scrollWidth > clientWidth`) and the unit contract in
  `src/components/chat/tools/components/codeSurfaceWrapping.spec.tsx`. A code block whose content
  runs past the right edge with a horizontal scrollbar is correct; don't report it as clipped or
  overflowing.
- The Settings pane's tab body (`src/components/settings/view/Settings.tsx`, `<main
  class="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">`) and the bug-report dialog's body
  (`src/components/bug-report/BugReportDialog.tsx`, `<div class="min-h-0 flex-1
  overflow-y-auto ...">`) are scroll containers. A row or field that is only partially visible at
  the top/bottom edge of either pane is the normal state of a scrollable region, not a clipping
  or layout bug — scroll it into view before judging it cut off.
- Touch targets on `iphone-13-pro` / `ipad-pro-11` use two repo conventions from PR #574 (and
  follow-ups), both floor the effective hit area at 44px without changing what's painted:
  `touch:hit-44` / `touch:hit-h-44` add a transparent, absolutely-positioned `::after`
  pseudo-element that widens the control's actual hit area (both axes for `hit-44`; height only
  for `hit-h-44`, used where controls sit in a tight `gap-1` row and widening both axes would
  steal taps from a neighbour) — see `MessageCopyControl`, `AboutTab`, `PremiumFeatureCard`,
  `OneLineDisplay`, and some controls in `SidebarHeader`. `touch:min-h-44` instead grows the
  control's own box for full-width rows with no neighbour to steal from — see `Reasoning`'s
  trigger and some rows in `SidebarHeader`. Either way, the control's own painted box can look
  smaller than 44px by design; its actual hit box is not. Don't flag these as too-small to tap.
  `MessageCopyControl`'s format-select chevron combines `touch:hit-h-44` with `min-w-6` (24px):
  the overlay only floors height, and its width tracks the painted box, so a painted box under
  the 24px minimum width still leaves an undersized hit area even with the overlay applied —
  `min-w-6` widens the painted box itself (with `inline-flex items-center justify-center` to
  keep the icon centred) rather than widening the overlay past the box, which would spill into
  the copy button 2px away in the same `gap-0.5` row.
- On-screen keyboard (iPhone/iPad recordings): the app shell, dialogs and the mobile sidebar
  overlay raise their bottom edge by `--keyboard-height` (`src/components/app/keyboardViewport.ts`),
  so the composer sits directly above the keyboard and the transcript / sidebar lists end at the
  keyboard's top edge. List rows and message controls scrolled past that edge are clipped by
  their scroll container (reachable by scrolling), not hidden behind the keyboard.
- **The keyboard stays open after Send, by design.** `ChatComposer`'s `handleSubmit` refocuses
  the textarea inside the click so a phone user can type the next message without re-tapping the
  box (the old behaviour closed the keyboard after every message). Don't report "keyboard
  remains open after sending".
- Inputs use 14px text on touch while `index.html`'s viewport meta has `maximum-scale=1.0`
  (commit fb1117a9, "Fixed mobile zoom on input"), so iOS does not zoom when a field is focused.
  Don't report a page zoom on focus.
- **Pinch-zoom stays disabled, by decision (Joseph, 2026-09-30).** `index.html`'s viewport meta
  sets `maximum-scale=1.0, user-scalable=no`; he does not pinch-zoom in cloudcli, so the 14px
  touch inputs are not upgraded to 16px and zoom is not re-enabled. The deterministic
  `zoom-disabled` DOM check (one page-level hit per touch mark since video-debugger #560) and
  any `ios-input-zoom` question are therefore **accepted, intentional** — not bugs. The template
  has no per-repo way to silence one DOM check, so that hit keeps appearing in every
  iPhone/iPad run; ignore it. Don't report the disabled zoom or 14px inputs either.
