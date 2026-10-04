"""Tests for the ios-sim (run_ios) half of flows/_helpers.py — IosApp's coordinate math and
keyboard check against a fake ios_hub.Device, plus the JS element finders run in a real Chromium
(marked `browser`, registered in ../conftest.py). No Simulator.

Underscore-prefixed, so vdebug.load_flows never mistakes it for a flow."""

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _helpers  # noqa: E402
from _helpers import IosApp, by_css, by_label, by_text  # noqa: E402


class FakeDevice:
    """Records native taps; answers eval_js from `answers`: the first (substring, value) whose
    substring occurs in the script wins. A callable value is called with the script."""

    def __init__(self, *answers, screen_minus_inner=47, source=""):
        self.answers = [("screen.height - window.innerHeight", screen_minus_inner), *answers]
        self.scripts, self.taps = [], []
        self.source_xml, self.source_calls = source, 0

    def source(self):
        self.source_calls += 1
        if isinstance(self.source_xml, Exception):
            raise self.source_xml
        return self.source_xml() if callable(self.source_xml) else self.source_xml

    def eval_js(self, script):
        self.scripts.append(script)
        for needle, value in self.answers:
            if needle in script:
                return value(script) if callable(value) else value
        return None

    def tap(self, x, y):
        self.taps.append((x, y))


class FakeVd:
    def __init__(self, frames=()):
        self.checks = []
        self.frames = [{"label": f} for f in frames]


# ------------------------------------------------------------------ offset calibration + taps
def tree(*nodes):
    """An XCUITest source dump holding `nodes`: (type, x, y, w, h[, label])."""
    body = "".join(f'<XCUIElementType{t} type="XCUIElementType{t}" x="{x}" y="{y}" width="{w}" '
                   f'height="{h}" visible="true" label="{(rest or [""])[0]}"/>' for t, x, y, w, h, *rest in nodes)
    return f'<?xml version="1.0"?><AppiumAUT><XCUIElementTypeApplication>{body}</XCUIElementTypeApplication></AppiumAUT>'


# The composer on an iPhone 13 Pro: DOM rect 16..374 x 667..731, centre (195, 699).
COMPOSER = {"x": 195, "y": 699, "w": 358, "h": 64, "tag": "textarea", "label": "Message", "vv": 0, "page": "p1"}


def app_for(target=COMPOSER, source="", hit=None, anchors=(), **kw):
    """IosApp over a fake device whose tap target is `target`, whose native tree is `source`,
    whose post-tap hit check answers `hit`, and whose anchor lookups answer `anchors`."""
    device = FakeDevice(("__vdTapHit = null", 1 if hit is not None else None),
                        ("return window.__vdTapHit;", hit),
                        ("scrollIntoView", target), *anchors, source=source, **kw)
    return IosApp(device, log=logs.append), device


logs: list[str] = []


@pytest.fixture(autouse=True)
def _clear_logs():
    logs.clear()


def test_fallback_inset_is_screen_height_minus_inner_height_measured_at_construction():
    device = FakeDevice()
    app = IosApp(device)
    assert app.fallback_inset == 47.0 and app.offsets == {}
    assert device.scripts == ["return screen.height - window.innerHeight"]
    assert device.source_calls == 0  # calibration is lazy: first tap


def test_fallback_inset_defaults_to_zero_when_eval_returns_nothing():
    assert IosApp(FakeDevice(screen_minus_inner=None)).fallback_inset == 0.0


def test_offset_is_zero_when_the_native_textview_sits_where_the_dom_says():
    # iOS 26.5 on current main: screen - innerHeight is 47, but the composer is natively at 667.
    app, device = app_for(source=tree(("TextView", 16, 667, 358, 64)))
    app.tap(by_css("textarea"), "composer")
    assert device.taps == [(195, 699)] and app.offsets == {"p1": 0.0} and logs == []


def test_offset_is_47_when_the_native_textview_is_47_lower():
    app, device = app_for(source=tree(("TextView", 16, 714, 358, 64)))
    app.tap(by_css("textarea"), "composer")
    assert device.taps == [(195, 746)] and app.offsets == {"p1": 47.0}


def test_x_is_never_shifted_even_with_an_offset():
    target = {**COMPOSER, "x": 100.4, "y": 200.6, "w": 50, "h": 20, "tag": "button", "label": "Send"}
    app, device = app_for(target, source=tree(("Button", 75.4, 237.6, 50, 20, "Send")))
    app.tap(by_label("Send"), "send")
    assert device.taps == [(100, 248)]  # round(100.4), round(200.6 + 47)


def test_no_matching_native_node_falls_back_to_screen_minus_inner_height_and_logs_it():
    # A native TextView of another size, and a Button where the target is a textarea.
    app, device = app_for(source=tree(("TextView", 16, 667, 300, 64), ("Button", 16, 667, 358, 64)),
                          screen_minus_inner=47)
    app.tap(by_css("textarea"), "composer")
    assert device.taps == [(195, 746)] and app.offsets == {"p1": 47.0}
    assert len(logs) == 1 and "falling back" in logs[0] and "47pt" in logs[0]


def test_an_unreadable_native_tree_falls_back_too():
    for source in (RuntimeError("no session"), "<not xml"):
        logs.clear()
        app, device = app_for(source=source)
        app.tap(by_css("textarea"), "composer")
        assert device.taps == [(195, 746)] and any("falling back" in m for m in logs)


def test_an_unmappable_target_calibrates_against_the_composer_anchor():
    menu_item = {"x": 60, "y": 300, "w": 120, "h": 40, "tag": "div", "label": "x", "page": "p1"}
    anchor = ("querySelectorAll('textarea')", COMPOSER)
    app, device = app_for(menu_item, source=tree(("TextView", 16, 667, 358, 64)), anchors=[anchor])
    app.tap(by_css("[cmdk-item]"), "item")
    assert device.taps == [(60, 300)] and app.offsets == {"p1": 0.0}


def test_falls_through_to_the_menu_button_anchor_when_there_is_no_composer():
    menu = {"x": 30, "y": 20, "w": 40, "h": 40, "tag": "button", "label": "Open menu", "page": "p1"}
    item = {"x": 60, "y": 300, "w": 120, "h": 40, "tag": "div", "page": "p1"}
    app, device = app_for(item, source=tree(("Button", 10, 47, 40, 40, "Open menu")),
                          anchors=[("querySelectorAll('textarea')", None), ('"Open menu"', menu)])
    app.tap(by_css("div"), "item")
    assert device.taps == [(60, 347)] and app.offsets == {"p1": 47.0}


def test_same_size_twins_are_told_apart_by_label_or_left_ambiguous():
    send = {**COMPOSER, "x": 350, "y": 699, "w": 32, "h": 32, "tag": "button", "label": "Send"}
    twins = [("Button", 334, 683, 32, 32, "Stop"), ("Button", 334, 730, 32, 32, "Send")]
    app, _ = app_for(send, source=tree(*twins))
    app.tap(by_label("Send"), "send")
    assert app.offsets == {"p1": 47.0}
    unlabeled = [("Button", 334, 683, 32, 32, "?"), ("Button", 334, 730, 32, 32, "?")]
    app, _ = app_for(send, source=tree(*unlabeled))
    app.tap(by_label("Send"), "send")
    assert app.offsets == {"p1": 47.0} and any("falling back" in m for m in logs)  # ambiguous


def test_a_same_size_node_in_another_column_is_not_the_target():
    send = {**COMPOSER, "x": 350, "y": 699, "w": 32, "h": 32, "tag": "button", "label": ""}
    app, _ = app_for(send, source=tree(("Button", 18, 683, 32, 32), ("Button", 334, 730, 32, 32)))
    app.tap(by_css("button"), "send")
    assert app.offsets == {"p1": 47.0} and logs == []  # the x-matched one, not the fallback


def test_the_offset_is_cached_per_page_and_recalibrated_on_a_new_page():
    pages = iter(["p1", "p1", "p2"])
    app, device = app_for(lambda _s: {**COMPOSER, "page": next(pages)},
                          source=tree(("TextView", 16, 667, 358, 64)))
    for _ in range(3):
        app.tap(by_css("textarea"), "composer")
    assert device.source_calls == 2 and set(app.offsets) == {"p1", "p2"}


def test_the_visual_viewport_pan_is_subtracted_from_the_dom_y():
    # Keyboard open: the layout viewport is panned 100pt up, so the element is 100pt higher on screen.
    panned = {**COMPOSER, "y": 799, "vv": 100}
    app, device = app_for(panned, source=tree(("TextView", 16, 667, 358, 64)))
    app.tap(by_css("textarea"), "composer")
    assert device.taps == [(195, 699)] and app.offsets == {"p1": 0.0}


def test_a_missed_tap_recalibrates_once_and_retaps_at_the_new_offset():
    sources = iter([tree(("TextView", 16, 714, 358, 64)), tree(("TextView", 16, 667, 358, 64))])
    app, device = app_for(source=lambda: next(sources), hit=False)
    app.tap(by_css("textarea"), "composer")
    assert device.taps == [(195, 746), (195, 699)] and app.offsets == {"p1": 0.0}
    assert any("missed" in m for m in logs)


def test_a_missed_tap_is_not_repeated_when_recalibration_agrees():
    app, device = app_for(source=tree(("TextView", 16, 667, 358, 64)), hit=False)
    app.tap(by_css("textarea"), "composer")
    assert device.taps == [(195, 699)] and device.source_calls == 2


def test_a_landed_tap_is_not_recalibrated():
    app, device = app_for(source=tree(("TextView", 16, 667, 358, 64)), hit=True)
    app.tap(by_css("textarea"), "composer")
    app.tap(by_css("textarea"), "composer")
    assert device.taps == [(195, 699)] * 2 and device.source_calls == 1


def test_tap_scrolls_the_element_into_view_and_reports_its_centre():
    device = FakeDevice(("getBoundingClientRect", {"x": 1, "y": 2}))
    app = IosApp(device)
    assert app.rect(by_css("#send"), "send") == {"x": 1, "y": 2}
    script = device.scripts[-1]
    assert "scrollIntoView" in script and "r.left + r.width / 2" in script and "r.top + r.height / 2" in script
    assert by_css("#send") in script


def test_rect_polls_until_the_element_appears():
    seen = iter([None, None, {"x": 5, "y": 6}])
    device = FakeDevice(("getBoundingClientRect", lambda _s: next(seen)))
    assert IosApp(device).rect(by_css("#x"), "x") == {"x": 5, "y": 6}


def test_rect_times_out_naming_the_element(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _s: None)
    with pytest.raises(TimeoutError, match="no visible the send button"):
        IosApp(FakeDevice(), timeout=0.01).rect(by_css("#send"), "the send button")


# ------------------------------------------------------------------ keyboard check
@pytest.mark.parametrize(("bottom", "flagged"), [(700, False), (701, False), (701.5, True), (900, True)])
def test_check_not_covered_fires_only_past_visible_bottom_plus_one(bottom, flagged):
    device = FakeDevice(("visibleBottom", {"top": 600, "bottom": bottom, "visibleBottom": 700}))
    vd = FakeVd(frames=["start", "keyboard open"])
    IosApp(device).check_not_covered(vd, by_css("textarea"), "composer")
    assert bool(vd.checks) is flagged
    if flagged:
        hit = vd.checks[0]
        assert hit["check"] == "keyboard-covers-control" and hit["selector"] == "composer"
        assert hit["source"] == "ios_run" and hit["frame"] == "keyboard open"
        assert hit["frames"] == ["keyboard open"]
        assert f"bottom {bottom:.0f}px" in hit["detail"] and "700px" in hit["detail"]


def test_check_not_covered_does_not_scroll_and_ignores_a_missing_element():
    device = FakeDevice(("visibleBottom", None))
    vd = FakeVd()
    IosApp(device).check_not_covered(vd, by_css("textarea"), "composer", check="custom")
    assert vd.checks == [] and "scrollIntoView" not in device.scripts[-1]


def test_check_not_covered_without_frames_and_with_a_custom_check_name():
    device = FakeDevice(("visibleBottom", {"top": 0, "bottom": 900, "visibleBottom": 700}))
    vd = FakeVd()
    IosApp(device).check_not_covered(vd, by_css("textarea"), "composer", check="custom")
    assert vd.checks[0]["check"] == "custom" and vd.checks[0]["frame"] is None and vd.checks[0]["frames"] == []


# ------------------------------------------------------------------ JS builders
def test_builders_quote_their_arguments_as_js_string_literals():
    assert '"Open menu"' in by_label("Open menu") and 'querySelectorAll("button")' in by_label("Open menu")
    assert 'querySelectorAll("a")' in by_label("x", tag="a")
    assert 'new RegExp("\\\\(120 turns\\\\)")' in by_text(r"\(120 turns\)")
    assert 'querySelectorAll("a, button")' in by_text("x")
    # A quote in the input cannot break out of the string literal.
    assert 'querySelectorAll("[data-x=\\"a\\"]")' in by_css('[data-x="a"]')
    for js in (by_label("x"), by_text("x"), by_css("x")):
        assert js.startswith("return ") and _helpers._TAPPABLE in js


# ------------------------------------------------------------------ the finders in a real DOM
PAGE = """<style>body { margin: 0; } button { width: 80px; height: 30px; }</style>
  <button id="covered" aria-label="Go">a</button>
  <div style="position: fixed; left: 0; top: 0; width: 200px; height: 40px; background: red"></div>
  <button id="drawer" style="position: fixed; left: -400px; top: 100px" aria-label="Go">b</button>
  <button id="drawer-far" style="position: absolute; left: -400px; top: 3000px">d</button>
  <button id="none" style="display: none" aria-label="Go">c</button>
  <button id="ok" style="position: absolute; top: 200px" aria-label="Go">Visible</button>
  <button id="far" style="position: absolute; left: 0; top: 3000px" title="Far">Far</button>
  <a id="link" href="#" style="position: absolute; top: 300px">Chat (120 turns)</a>"""


@pytest.fixture(scope="module")
def page():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            pg = browser.new_page(viewport={"width": 390, "height": 600})
            pg.set_content(PAGE)
            yield pg
        finally:
            browser.close()


def _found_id(page, find_js):
    return page.evaluate("() => { const el = (() => { " + find_js + " })(); return el ? el.id : null; }")


@pytest.mark.browser  # real Chromium
def test_tappable_skips_covered_off_screen_and_hidden_matches(page):
    # Four "Go" buttons: under an overlay, slid off-screen left, display:none, and the real one.
    assert _found_id(page, by_label("Go")) == "ok"
    assert _found_id(page, by_css("#covered")) is None
    assert _found_id(page, by_css("#drawer")) is None
    # Off to the side AND below the fold: the x test must reject it before the fold lets it pass.
    assert _found_id(page, by_css("#drawer-far")) is None
    assert _found_id(page, by_css("#none")) is None


@pytest.mark.browser  # real Chromium
def test_tappable_keeps_below_the_fold_content_and_finds_by_text(page):
    assert _found_id(page, by_label("Far")) == "far"  # off the bottom: passes, the tap scrolls it in
    assert _found_id(page, by_text(r"\(120 turns\)")) == "link"
    assert _found_id(page, by_text("nope")) is None


@pytest.mark.browser  # real Chromium
def test_centre_and_extent_scripts_in_a_real_dom(page):
    extent = page.evaluate("() => { %s }" % (_helpers._EXTENT_JS % by_label("Far")))
    assert extent["top"] == 3000 and extent["visibleBottom"] == 600  # measured where it is, no scroll
    centre = page.evaluate("() => { %s }" % (_helpers._CENTRE_JS % by_label("Far")))
    assert 0 <= centre["y"] <= 600 and centre["x"] == 40  # scrolled into view first
    assert page.evaluate("() => { %s }" % (_helpers._CENTRE_JS % by_css("#missing"))) is None
