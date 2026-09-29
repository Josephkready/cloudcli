"""Shared helpers for cloudcli vdebug flows.

The app under test is the throwaway fixture server from `vdebug/serve-fixture.ts`
(synthetic transcripts, mock chat provider, auth disabled) — never a real library.
"""

import re

# The seeded conversations are CLI-origin, which the sidebar hides by default (#216).
# Same override bench/run.ts uses. Must run before the app boots, hence an init script.
SHOW_CLI_CHATS = (
    "try { localStorage.setItem('claude-settings', JSON.stringify({ hideCliOriginChats: false })); } catch (e) {}"
)

LARGE_CONVERSATION = re.compile(r"\(120 turns\)")


def boot(page, vd, path="/"):
    """Open the app with the seeded CLI chats visible, and take the 'start' mark."""
    page.add_init_script(SHOW_CLI_CHATS)
    vd.goto(path)
    # Docked sidebar: a conversation row. Small screens: the drawer's menu button.
    page.get_by_role("link", name=re.compile(r"turns\)")).or_(
        page.get_by_role("button", name="Open menu")).first.wait_for()
    vd.mark("start")


def visible(locator):
    """First visible match — desktop and mobile layouts both mount some controls twice."""
    return locator.filter(visible=True).first


def open_sidebar(page, vd, label="sidebar open"):
    """Open the mobile drawer when the layout has one; a no-op where the sidebar is docked."""
    menu = page.get_by_role("button", name="Open menu")
    if menu.count() and menu.first.is_visible():
        menu.first.click()
        visible(page.get_by_role("button", name="Close sidebar")).wait_for()
        vd.mark(label)
        return True
    return False


def open_large_conversation(page, vd):
    open_sidebar(page, vd)
    visible(page.get_by_role("link", name=LARGE_CONVERSATION)).click()
    page.locator(".chat-message").first.wait_for()
