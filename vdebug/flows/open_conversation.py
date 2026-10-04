"""Open a long existing conversation, scroll its transcript, and switch sessions."""

import re

import time

from _helpers import boot, ios_boot, ios_open_large_conversation, open_large_conversation, visible

NAME = "open-conversation"
DESCRIPTION = ("Pick a ~120-turn conversation from the sidebar -> transcript renders at the "
               "bottom; scroll up through older messages; then switch to another open session")
SOURCE = "standard"
START = None


def run(page, vd):
    boot(page, vd)
    open_large_conversation(page, vd)
    vd.mark("transcript loaded")
    page.locator(".chat-message").first.hover()
    page.mouse.wheel(0, -1800)
    page.wait_for_timeout(600)
    vd.mark("scrolled up")
    # Narrow layouts collapse the open-session tabs into a menu button.
    menu = page.get_by_role("button", name=re.compile(r"open sessions menu$"))
    if menu.count() and menu.first.is_visible():
        menu.first.click()
        vd.mark("sessions menu")
        visible(page.get_by_role("menuitem", name=re.compile(r"\(40 turns\)"))).click()
    else:
        visible(page.get_by_role("button", name=re.compile(r"Index bounda"))).click()
    page.get_by_text("bench-marker-", exact=False).first.wait_for()
    vd.mark("switched session")


# The transcript scrolls inside its own container, not the window (ios_hub's device.scroll() is a
# window.scrollBy), so scroll the nearest scrollable ancestor of a message directly.
_SCROLL_TRANSCRIPT = """let el = document.querySelector('.chat-message');
while (el && !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)))
  el = el.parentElement;
if (!el) return null;
el.scrollTop -= %d;
return Math.round(el.scrollTop);"""


def run_ios(device, vd):
    """Open the long conversation on a real iOS Simulator (standalone PWA) and scroll up through
    it in steps, so Safari's rendering of older messages (#495: position jumps) is recorded."""
    app = ios_boot(device, vd)
    ios_open_large_conversation(app, vd)
    time.sleep(1.0)
    vd.mark("transcript loaded")
    for _ in range(6):
        if app.js(_SCROLL_TRANSCRIPT % 300) is None:
            raise RuntimeError("ios-sim: found no scrollable transcript container")
        time.sleep(0.25)
    time.sleep(0.6)
    vd.mark("scrolled up")
