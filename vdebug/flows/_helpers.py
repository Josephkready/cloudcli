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
    if page.get_by_role("button", name="Close sidebar").filter(visible=True).count():
        return False  # already open
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


def open_settings(page, vd, tab=None):
    """Open the Settings modal from the sidebar footer, optionally on a given tab."""
    open_sidebar(page, vd)
    visible(page.get_by_role("button", name="Settings")).click()
    dialog = visible(page.get_by_role("dialog"))
    dialog.wait_for()
    if tab:
        visible(dialog.get_by_role("button", name=tab, exact=True)).click()
    return dialog


def expand_spaces(page):
    """Expand the sidebar's Spaces (project list) section if it is collapsed."""
    toggle = visible(page.get_by_role("button", name="Toggle spaces"))
    if toggle.get_attribute("aria-expanded") == "false":
        toggle.click()


def project_action(page, name, action):
    """Click a project row's 'Rename' or 'Remove' action.

    Drawer (small screens): labelled 'Rename Project' / 'Remove Project' buttons, always shown.
    Docked sidebar: icons revealed on hover, titled 'Rename project (F2)' / 'Remove project from
    sidebar (Delete)'.
    """
    expand_spaces(page)
    row = visible(page.get_by_test_id(re.compile(r"^sidebar-project-row(-mobile)?$")).filter(has_text=name))
    row.hover()
    visible(row.get_by_role("button", name=f"{action} Project", exact=True).or_(
        row.get_by_title(re.compile(rf"^{action} project")))).click()


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


# ------------------------------------------------------------------ ios-sim (run_ios)
# A flow's optional run_ios(device, vd) drives the real iOS Simulator (`--viewports ios-sim`)
# through an ios_hub.Device: no Playwright locators, only eval_js + native taps. IosApp wraps the
# two things every cloudcli run_ios needs: finding an element by role/label/text in the page, and
# tapping it with a REAL native touch (focus from a synthetic click does not open the keyboard the
# way a finger does, which is the whole point of running on a Simulator).

# Resolve an element from a JS function body over `document` (see by_label/by_text/by_css), then
# report its centre (to tap) or its vertical extent against the visible viewport (keyboard check).
# Only the tap path scrolls the element into view: the extent check must see it where it is.
_FIND_JS = "const el = (() => { %s })();\nif (!el) return null;\n"
_CENTRE_JS = _FIND_JS + """el.scrollIntoView({block: 'nearest'});
const r = el.getBoundingClientRect();
return r.width && r.height ? {x: r.left + r.width / 2, y: r.top + r.height / 2} : null;"""
_EXTENT_JS = _FIND_JS + """const r = el.getBoundingClientRect();
return {top: r.top, bottom: r.bottom, visibleBottom: visualViewport.offsetTop + visualViewport.height};"""


def js_str(s: str) -> str:
    """A Python str as a JS string literal (JSON is valid JS)."""
    import json
    return json.dumps(s)


# "Tappable": rendered, horizontally on screen (a closed drawer keeps its links mounted, slid off
# to the left), and — when vertically on screen — the topmost thing at its centre, so a drawer or
# dialog covering it disqualifies it (a native tap there would land on the overlay instead).
# Content above/below the fold passes; the tap path scrolls it into view first.
_TAPPABLE = ("(e => { if (!e.getClientRects().length) return false; const r = e.getBoundingClientRect(); "
             "const x = r.left + r.width / 2, y = r.top + r.height / 2; "
             "if (x < 0 || x > innerWidth) return false; "
             "if (y < 0 || y > innerHeight) return true; "
             "const h = document.elementFromPoint(x, y); return !!h && (h === e || e.contains(h)); })")


def by_label(label: str, tag: str = "button") -> str:
    """JS finding the first visible `tag` whose aria-label/title/text matches `label` exactly."""
    return (f"return [...document.querySelectorAll({js_str(tag)})].find(e => {_TAPPABLE}(e) && "
            f"[e.getAttribute('aria-label'), e.getAttribute('title'), e.textContent.trim()].includes({js_str(label)}));")


def by_text(pattern: str, tag: str = "a, button") -> str:
    """JS finding the first tappable `tag` whose text matches the JS regex source `pattern`."""
    return (f"return [...document.querySelectorAll({js_str(tag)})].find(e => {_TAPPABLE}(e) && "
            f"new RegExp({js_str(pattern)}).test(e.textContent));")


def by_css(selector: str) -> str:
    """JS finding the first tappable match of a CSS selector (prefer data-slot/test ids, not paths)."""
    return f"return [...document.querySelectorAll({js_str(selector)})].find({_TAPPABLE});"


class IosApp:
    """cloudcli's standalone PWA on an ios_hub.Device, addressed in DOM terms.

    `device.tap(x, y)` takes SCREEN points, but getBoundingClientRect() is in viewport points. In a
    standalone PWA the webview starts below the status bar, so screen y = viewport y + the top
    inset (47pt on an iPhone 13 Pro: 844 screen - 797 innerHeight). The inset is measured once at
    construction — with the keyboard closed, because innerHeight can dip while it animates.
    """

    def __init__(self, device, timeout: float = 20.0):
        self.device = device
        self.timeout = timeout
        self.top_inset = float(device.eval_js("return screen.height - window.innerHeight") or 0)

    def js(self, script: str):
        return self.device.eval_js(script)

    def wait(self, condition_js: str, what: str, timeout: float | None = None):
        """Poll a JS expression (wrapped in `return`) until truthy; return its value."""
        import time
        deadline = time.monotonic() + (timeout or self.timeout)
        while True:
            value = self.js(f"return ({condition_js});")
            if value:
                return value
            if time.monotonic() > deadline:
                raise TimeoutError(f"ios-sim: timed out waiting for {what}")
            time.sleep(0.25)

    def rect(self, find_js: str, what: str) -> dict:
        import time
        deadline = time.monotonic() + self.timeout
        while True:
            r = self.js(_CENTRE_JS % find_js)
            if r:
                return r
            if time.monotonic() > deadline:
                raise TimeoutError(f"ios-sim: no visible {what}")
            time.sleep(0.25)

    def tap(self, find_js: str, what: str) -> None:
        """A native touch at the centre of the element `find_js` resolves to."""
        r = self.rect(find_js, what)
        self.device.tap(x=round(r["x"]), y=round(r["y"] + self.top_inset))

    def go(self, path: str) -> None:
        """In-app navigation (location assignment) — stays inside the standalone window, unlike
        device.navigate(), which drives Safari's URL bar."""
        self.js(f"location.assign({js_str(path)}); return 1;")

    def keyboard_height(self) -> float:
        """How much of the layout viewport the on-screen keyboard currently hides."""
        return float(self.js("return window.innerHeight - visualViewport.height - visualViewport.offsetTop") or 0)

    def check_not_covered(self, vd, find_js: str, what: str, check: str = "keyboard-covers-control") -> None:
        """Record a check hit on `vd` when the element's bottom is below the visible viewport —
        the iOS-real counterpart of the Chromium keyboard checks (layout_checks.js)."""
        r = self.js(_EXTENT_JS % find_js)
        if r and r["bottom"] > r["visibleBottom"] + 1:
            vd.checks.append({"check": check, "selector": what, "rect": None, "source": "ios_run",
                              "frame": vd.frames[-1]["label"] if vd.frames else None,
                              "frames": [vd.frames[-1]["label"]] if vd.frames else [],
                              "detail": f"{what} bottom {r['bottom']:.0f}px is below the visible "
                                        f"viewport bottom {r['visibleBottom']:.0f}px (keyboard covering it)"})


def ios_boot(device, vd) -> IosApp:
    """Show the seeded CLI chats (like boot()), reload, wait for the shell, mark 'start'."""
    app = IosApp(device)
    app.js(SHOW_CLI_CHATS + " location.reload(); return 1;")
    app.wait("document.querySelector('[aria-label=\"Open menu\"], a[href*=\"/session/\"]')", "the app shell")
    vd.mark("start")
    return app


# The drawer's backdrop is a full-width "Close sidebar" button under the drawer itself, so it is
# never tappable at its centre; its presence is what says the drawer is open.
_DRAWER_OPEN = "!!document.querySelector('[aria-label=\"Close sidebar\"]')"


def ios_open_sidebar(app: IosApp, vd) -> None:
    if app.js(f"return {_DRAWER_OPEN};"):
        return
    app.tap(by_label("Open menu"), "'Open menu' button")
    app.wait(_DRAWER_OPEN, "the sidebar drawer")
    vd.mark("sidebar open")


def ios_open_large_conversation(app: IosApp, vd) -> None:
    """Tap the 120-turn conversation: listed on the phone's 'Choose Your Conversation' screen or in
    an already-open drawer; otherwise open the drawer first. Waits for the list to render."""
    link = by_text(r"\(120 turns\)")
    app.wait(f"(() => {{ {link} }})() || (() => {{ {by_label('Open menu')} }})()",
             "the conversation list or the menu button")
    if not app.js(link):
        ios_open_sidebar(app, vd)
    app.tap(link, "the 120-turn conversation link")
    app.wait("document.querySelector('.chat-message')", "the transcript")
