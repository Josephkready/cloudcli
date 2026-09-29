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


# ------------------------------------------------------------------ gestures
# Ported from the video-debugger skill's flows/_helpers.py template. No current cloudcli flow
# drives a drag/pinch gesture, but the sidebar's resize handle (WP5) is a drag target, so keep
# these here for the flow that eventually covers it — `pinch` needs a touch context, which the
# iphone-13-pro / ipad-pro-11 presets have (mobile=True).

def _centre(locator):
    box = locator.bounding_box()
    if box is None:
        raise ValueError("element is not visible")
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def drag(page, locator, dx: float, dy: float, *, steps: int = 12) -> None:
    """Press in the middle of `locator`, move by (dx, dy) in `steps` moves, release."""
    x, y = _centre(locator)
    page.mouse.move(x, y)
    page.mouse.down()
    for i in range(1, steps + 1):
        page.mouse.move(x + dx * i / steps, y + dy * i / steps)
    page.mouse.up()


def wheel_zoom(page, locator, delta_y: float, *, at: tuple[float, float] = (0.5, 0.5)) -> None:
    """Scroll-wheel over a point of `locator` (fractions of its box; default the centre)."""
    box = locator.bounding_box()
    if box is None:
        raise ValueError("element is not visible")
    page.mouse.move(box["x"] + box["width"] * at[0], box["y"] + box["height"] * at[1])
    page.mouse.wheel(0, delta_y)


def pinch(page, locator, scale: float, *, steps: int = 10, spread: float = 40) -> None:
    """Two-finger pinch around the middle of `locator`: scale > 1 zooms in, < 1 zooms out."""
    cdp = page.context.new_cdp_session(page)
    x, y = _centre(locator)

    def points(d):
        return [{"x": x - d, "y": y, "id": 0}, {"x": x + d, "y": y, "id": 1}]

    try:
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": points(spread)})
        for i in range(1, steps + 1):
            d = spread * (1 + (scale - 1) * i / steps)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": points(d)})
            page.wait_for_timeout(16)
    finally:
        try:  # always end the touch sequence, or the next gesture on this page starts mid-touch
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        finally:
            cdp.detach()
