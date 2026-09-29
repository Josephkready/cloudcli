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
