"""Open a long existing conversation, scroll its transcript, and switch sessions."""

import re

from _helpers import boot, open_large_conversation, visible

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
