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

    def __init__(self, *answers, screen_minus_inner=47):
        self.answers = [("screen.height - window.innerHeight", screen_minus_inner), *answers]
        self.scripts, self.taps = [], []

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


# ------------------------------------------------------------------ top inset + taps
def test_top_inset_is_screen_height_minus_inner_height_measured_once():
    device = FakeDevice()
    app = IosApp(device)
    assert app.top_inset == 47.0
    assert device.scripts == ["return screen.height - window.innerHeight"]


def test_top_inset_defaults_to_zero_when_eval_returns_nothing():
    assert IosApp(FakeDevice(screen_minus_inner=None)).top_inset == 0.0


def test_tap_offsets_y_by_the_top_inset_but_not_x():
    device = FakeDevice(("getBoundingClientRect", {"x": 100.4, "y": 200.6}))
    IosApp(device).tap(by_css("#send"), "send")
    assert device.taps == [(100, 248)]  # round(100.4), round(200.6 + 47)


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
