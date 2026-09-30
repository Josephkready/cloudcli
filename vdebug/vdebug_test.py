"""Tests for vdebug.py's pure helpers (viewport parsing/sizing, flow loading, exit codes,
report rendering, CLI wiring). No browser, no capture backend.

cloudcli's capture path is the Node/TS module under server/modules/vdebug-capture/ (with its
own vitest suite), not the Python flowstore.py template — so the template's real-browser
tests against the broken.html fixture app + flowstore round-trip are NOT ported here; see the
port report for what covers that instead. The tap-target, on-screen keyboard and layout-check
probes below DO drive a real Chromium; they are marked `browser` (registered in conftest.py).
"""

import http.server
import json
import pathlib
import sys
import threading

import pytest

HERE = pathlib.Path(__file__).resolve().parent
CAPTURE_DIR = HERE / "capture"               # flowstore_test.py lives here
sys.path.insert(0, str(HERE))
import vdebug  # noqa: E402


# ------------------------------------------------------------------ viewports
def test_parse_viewports_mixes_all_with_custom():
    vps = vdebug.parse_viewports("all,kiosk=2560x1600,mobile")   # "mobile" is an alias of iphone-13-pro
    assert [v.name for v in vps] == ["iphone-13-pro", "ipad-pro-11", "2k", "4k", "half-2k", "third-4k", "kiosk"]


def test_parse_viewports_presets_custom_and_all():
    assert [(v.name, v.width, v.height, v.mobile) for v in vdebug.parse_viewports("all")] == [
        ("iphone-13-pro", 390, 844, True), ("ipad-pro-11", 834, 1194, True), ("2k", 2560, 1440, False),
        ("4k", 3840, 2160, False), ("half-2k", 1280, 1440, False), ("third-4k", 1280, 2160, False)]
    assert [v.name for v in vdebug.parse_viewports("mobile,tablet,desktop,ultrawide")] == [
        "iphone-13-pro", "ipad-pro-11", "2k", "4k"]                   # old generic names still work
    se, big = vdebug.parse_viewports("phone-se=320x568, 1920x1080")
    assert (se.name, se.width, se.mobile) == ("phone-se", 320, True)
    assert (big.name, big.mobile) == ("1920x1080", False)
    with pytest.raises(ValueError):
        vdebug.parse_viewports("watch")


def test_canonical_maps_aliases_and_passes_through():
    assert vdebug.canonical("mobile") == "iphone-13-pro"
    assert vdebug.canonical("tablet") == "ipad-pro-11"
    assert vdebug.canonical("desktop") == "2k"
    assert vdebug.canonical("ultrawide") == "4k"
    assert vdebug.canonical("iphone-13-pro") == "iphone-13-pro"
    assert vdebug.canonical("kiosk") == "kiosk"


def test_video_size_caps_long_edge_and_stays_even():
    assert vdebug.video_size(vdebug.VIEWPORTS["iphone-13-pro"]) == {"width": 390, "height": 844}
    assert vdebug.video_size(vdebug.VIEWPORTS["4k"]) == {"width": 1920, "height": 1080}
    assert vdebug.video_size(vdebug.VIEWPORTS["third-4k"]) == {"width": 1136, "height": 1920}


def test_reset_cmd_errors_are_reported():
    assert vdebug.run_reset("true") is None
    assert vdebug.run_reset("echo nope >&2; exit 3") == "reset-cmd exited 3: nope"


# ------------------------------------------------------------------ flow loading
def _write_flow(d, name, body="def run(page, vd):\n    pass\n", extra=""):
    (d / f"{name.replace('-', '_')}.py").write_text(f'NAME = "{name}"\n{extra}\n{body}')


def test_load_flows_contract(tmp_path):
    _write_flow(tmp_path, "a", extra='VIEWPORTS = ["mobile"]\nMUST_FIT = ["tablet"]\nSOURCE = "mined:abc"')
    (tmp_path / "_helpers.py").write_text("x = 1\n")
    (tmp_path / "a_test.py").write_text("")
    [f] = vdebug.load_flows(tmp_path)
    assert (f.name, f.viewports, f.source, f.start, f.must_fit) == ("a", ["mobile"], "mined:abc", "/", ["tablet"])
    assert vdebug.select_flows([f], ["a*"]) == [f]
    with pytest.raises(ValueError):
        vdebug.select_flows([f], ["zzz"])
    (tmp_path / "b.py").write_text('NAME = "a"\ndef run(page, vd): pass\n')
    with pytest.raises(ValueError, match="duplicate"):
        vdebug.load_flows(tmp_path)


def test_load_flows_requires_run(tmp_path):
    (tmp_path / "x.py").write_text('NAME = "x"\n')
    with pytest.raises(ValueError, match="run"):
        vdebug.load_flows(tmp_path)


def test_cloudcli_flows_load_and_import_helpers():
    """Sanity check on the real flows/ dir: every flow imports and has a run()."""
    flows = vdebug.load_flows(HERE / "flows")
    names = {f.name for f in flows}
    assert {"new-chat-turn", "settings", "search-chats", "bug-report", "home-sidebar",
           "open-conversation", "not-found"} <= names


# ------------------------------------------------------------------ exit codes / reporting
def test_exit_code_levels():
    ok = {"runs": [{"checks": [], "error": None, "judge": {"findings": [{"severity": "minor"}]}}]}
    hit = {"runs": [{"checks": [{"check": "x"}], "error": None}]}
    major = {"runs": [{"checks": [], "error": None, "judge": {"findings": [{"severity": "major"}]}}]}
    crash = {"runs": [{"checks": [], "error": "boom"}]}
    assert [vdebug.exit_code(ok, m) for m in ("error", "check", "major")] == [0, 0, 0]
    assert [vdebug.exit_code(hit, m) for m in ("error", "check", "major")] == [0, 1, 0]
    assert [vdebug.exit_code(major, m) for m in ("error", "check", "major")] == [0, 1, 1]
    assert vdebug.exit_code(crash, "error") == 1 and vdebug.exit_code(crash, "never") == 0


def test_report_links_findings_to_the_judges_film_frames(tmp_path):
    report = {"run_id": "r", "base_url": "u", "judge": {"model": "m/x", "fps": 10, "cost_usd": 0.001}, "runs": [{
        "flow": "f", "viewport": "mobile", "width": 375, "height": 667, "video": "f/mobile/video.webm",
        "frames": [{"label": "start", "t": 0.5, "path": "f/mobile/frames/01-start.png"}], "checks": [], "error": None,
        "judge": {"summary": "s", "coverage": {"frames": 2, "reviewed": 1, "missing": ["t=1.20s"]},
                  "film": [{"label": "t=1.20s", "t": 1.2, "path": "f/mobile/film/000012.png"}],
                  "findings": [{"title": "Toast flies", "severity": "major", "category": "animation",
                                "frame": "t=1.20s", "description": "d", "location": "l"}]}}]}
    md = vdebug.write_markdown(tmp_path, report).read_text()
    assert "([frame](f/mobile/film/000012.png))" in md
    assert "no verdict for frames:** t=1.20s" in md


def test_cli_judge_wiring_passes_fps_model_and_notes(tmp_path, monkeypatch):
    """record --judge reaches judge.judge_run with --fps/--model and judge_notes.md wiring."""
    import judge
    run_dir = tmp_path / "runs" / "r1"
    run_dir.mkdir(parents=True)
    (run_dir / "report.json").write_text(json.dumps({"run_id": "r1", "base_url": "u", "runs": []}))
    monkeypatch.setattr(vdebug, "record", lambda *a, **k: run_dir)
    seen = {}

    def fake_judge_run(rd, **kw):
        seen.update(kw)
        return {"run_id": "r1", "base_url": "u", "runs": [], "judge": {"model": kw["model"], "fps": kw["fps"],
                                                                       "cost_usd": 0.0}}
    monkeypatch.setattr(judge, "judge_run", fake_judge_run)
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    rc = vdebug.main(["--flows-dir", str(HERE / "flows"), "record", "--base-url", "http://x", "--judge",
                      "--fps", "15", "--model", "m/x"])
    assert rc == 0 and seen["fps"] == 15 and seen["model"] == "m/x"
    assert seen["notes"] == judge.load_notes(vdebug.HERE / "judge_notes.md")
    assert "video frames @ 15 fps" in (run_dir / "report.md").read_text()


def test_judge_notes_file_exists_and_is_loadable():
    import judge
    notes = judge.load_notes(vdebug.HERE / "judge_notes.md")
    assert notes and "hit-44" in notes and "code-block-scroll" in notes


# ------------------------------------------------------------------ layout_checks.js
# cloudcli's `touch:hit-44` / `touch:hit-h-44` (src/index.css) hang a centred, transform-
# positioned `::after` off a small control to floor its hit area at 44px. The tap-target
# check must read that overlay, and must run on a touch tablet wider than 768px too.
HIT_CSS = """
  .hit { position: relative; }
  .hit::after { content: ''; position: absolute; top: 50%; left: 50%;
                transform: translate(-50%, -50%); width: 100%; height: 100%; min-height: 44px; }
  .hit.both::after { min-width: 44px; }
  button { width: 20px; height: 16px; padding: 0; margin: 60px; border: 0; }
"""
HIT_HTML = f"""<style>{HIT_CSS}</style>
  <button id="bare">x</button>
  <button id="both" class="hit both">x</button>
  <button id="h-only" class="hit">x</button>
  <button id="wide-h" class="hit" style="width:32px">x</button>"""


def _tap_hits(vp_name: str) -> dict:
    sync_api = pytest.importorskip("playwright.sync_api")
    vp = vdebug.VIEWPORTS[vp_name]
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_context(viewport={"width": vp.width, "height": vp.height},
                                       is_mobile=vp.mobile, has_touch=vp.mobile).new_page()
            page.set_content(HIT_HTML)
            hits = page.evaluate(vdebug.LAYOUT_CHECKS_JS)
        finally:
            browser.close()
    return {h["selector"]: h["detail"] for h in hits if h["check"] == "small-tap-target"}


@pytest.mark.browser  # real Chromium
@pytest.mark.parametrize("vp_name", ["iphone-13-pro", "ipad-pro-11"])
def test_tap_target_reads_the_after_overlay_on_touch_viewports(vp_name):
    hits = _tap_hits(vp_name)
    flagged = {sel.lstrip("#") for sel in hits}
    # bare 20x16 and the height-only overlay (20x44 — still under 24 wide) are real gaps;
    # the both-axes overlay (44x44) and a 32px-wide height-only overlay (32x44) are not.
    assert flagged == {"bare", "h-only"}, hits
    assert hits["#h-only"] == "20x44px effective hit area (20x16px painted + ::before/::after) < 24x24"
    assert hits["#bare"] == "20x16px < 24x24"


@pytest.mark.browser  # real Chromium
def test_tap_target_check_skips_mouse_desktop():
    assert _tap_hits("half-2k") == {}


# ------------------------------------------------------------------ flow selection / loading (synced)
def test_flow_selection_accepts_comma_lists(tmp_path):
    for n in ("alpha", "beta", "gamma"):
        _write_flow(tmp_path, n)
    flows = vdebug.load_flows(tmp_path)
    assert [f.name for f in vdebug.select_flows(flows, ["alpha,gam*"])] == ["alpha", "gamma"]
    assert [f.name for f in vdebug.select_flows(flows, ["beta", "gamma"])] == ["beta", "gamma"]


def test_second_load_moves_its_flows_dir_to_the_front(tmp_path):
    """If dir B was already on sys.path BEHIND dir A, loading B must still put B first."""
    a, b = tmp_path / "a", tmp_path / "b"
    for d in (a, b):
        d.mkdir()
        (d / "_helpers.py").write_text(f'WHO = "{d.name}"\n')
        (d / "f.py").write_text(f'NAME = "f-{d.name}"\nfrom _helpers import WHO\ndef run(page, vd): pass\n')
    vdebug.load_flows(b)
    vdebug.load_flows(a)
    [flow] = vdebug.load_flows(b)
    assert flow.run.__globals__["WHO"] == "b"
    assert sys.path[0] == str(b.resolve())
    vdebug.load_flows(HERE / "flows")  # leave the real flows dir in front for later tests


# ------------------------------------------------------------------ on-screen keyboard (synced)
# The template's keyboard tests, against testdata/keyboard.html served by a tiny static server
# (cloudcli has no Python flowstore app fixture — its capture is the Node module).
@pytest.fixture(scope="module")
def app():
    keyboard_html = (HERE / "testdata" / "keyboard.html").read_bytes()

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(keyboard_html)

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", None
    srv.shutdown()


def _run_kb(app, tmp_path, name, body, viewports="iphone-13-pro", extra=""):
    pytest.importorskip("playwright.sync_api")
    base, _ = app
    d = tmp_path / name
    d.mkdir()
    (d / f"{name.replace('-', '_')}.py").write_text(f'NAME = "{name}"\nSTART = "/keyboard"\n{extra}\n{body}')
    [flow] = vdebug.load_flows(d)
    run_dir = vdebug.record([flow], vdebug.parse_viewports(viewports), base, tmp_path / f"runs-{name}",
                            log=lambda m: None)
    return {e["viewport"]: e for e in json.loads((run_dir / "report.json").read_text())["runs"]}


def _checks(entry, label=None):
    return {(c["check"], c["selector"]) for c in entry["checks"] if label is None or label in c["frames"]}


def test_touch_presets_have_keyboards_and_desktops_do_not():
    vps = {v.name: v for v in vdebug.parse_viewports("all,phone=320x568,wide=1920x1080")}
    assert vps["iphone-13-pro"].keyboard == 336 and vps["ipad-pro-11"].keyboard == 360
    assert vps["phone"].keyboard == round(568 * 0.4) and vps["2k"].keyboard == 0 and vps["wide"].keyboard == 0


def test_cloudcli_text_entry_flows_keep_the_keyboard_on():
    """The composer/search/bug-report flows exist to exercise the keyboard; none may opt out."""
    flows = {f.name: f for f in vdebug.load_flows(HERE / "flows")}
    for name in ("new-chat-turn", "search-chats", "bug-report", "composer-keyboard"):
        assert flows[name].keyboard is True, name


@pytest.mark.browser  # real Chromium
def test_keyboard_hides_a_fixed_bottom_bar_that_ignores_it(app, tmp_path):
    body = ("def run(page, vd):\n"
            "    page.evaluate(\"window.__vvResizes = 0; visualViewport.addEventListener('resize', () => window.__vvResizes++)\")\n"
            "    page.locator('#msg').click()\n"
            "    vd.mark('typing')\n"
            "    assert page.evaluate('window.visualViewport.height') == 844 - 336\n"
            "    assert page.evaluate('window.__vvResizes') >= 1\n"
            "    assert page.locator('#__vd_keyboard').count() == 1\n"
            "    page.locator('#send').click(force=True)\n"
            "    vd.mark('sent')\n"
            "    assert page.locator('#__vd_keyboard').count() == 0\n"
            "    assert page.evaluate('window.visualViewport.height') == 844\n")
    e = _run_kb(app, tmp_path, "kb-bar", body)["iphone-13-pro"]
    assert e["error"] is None, e["error"]
    typing = _checks(e, "typing")
    assert ("keyboard-covers-focus", "#msg") in typing and ("keyboard-covers-control", "#send") in typing
    assert ("keyboard-covers-control", "#draft") in typing          # position:sticky pins it too
    assert not {c for c in _checks(e, "sent") if c[0].startswith("keyboard-")} - typing


@pytest.mark.browser  # real Chromium
def test_keyboard_aware_bar_passes_and_far_field_is_scrolled_into_view(app, tmp_path):
    body = ("def run(page, vd):\n"
            "    vd.goto('/keyboard?aware=1')\n"
            "    page.locator('#msg').click()\n"
            "    vd.mark('aware typing')\n"
            "    page.locator('#late').focus()\n"
            "    vd.mark('late field')\n")
    e = _run_kb(app, tmp_path, "kb-aware", body)["iphone-13-pro"]
    assert e["error"] is None, e["error"]
    assert not any(c[0].startswith("keyboard-") for c in _checks(e, "aware typing"))
    assert ("keyboard-covers-focus", "#late") not in _checks(e, "late field")


@pytest.mark.browser  # real Chromium
def test_ios_input_zoom_flagged_on_touch_only_and_no_keyboard_on_desktop(app, tmp_path):
    body = "def run(page, vd):\n    page.locator('#name').click()\n    vd.mark('focused')\n"
    by = _run_kb(app, tmp_path, "kb-zoom", body, viewports="iphone-13-pro,2k")
    phone, desk = by["iphone-13-pro"], by["2k"]
    assert ("ios-input-zoom", "#note") in _checks(phone) and ("ios-input-zoom", "#name") not in _checks(phone)
    assert not any(c[0] == "ios-input-zoom" for c in _checks(desk))
    assert not any(c[0].startswith("keyboard-") for c in _checks(desk))


@pytest.mark.browser  # real Chromium
def test_flow_can_opt_out_of_the_keyboard(app, tmp_path):
    body = ("def run(page, vd):\n"
            "    page.locator('#msg').click()\n"
            "    assert page.locator('#__vd_keyboard').count() == 0\n"
            "    vd.mark('typing')\n")
    e = _run_kb(app, tmp_path, "kb-off", body, extra="KEYBOARD = False")["iphone-13-pro"]
    assert e["error"] is None, e["error"]
    assert e["keyboard"] is False
    assert not any(c[0].startswith("keyboard-") for c in _checks(e))


@pytest.mark.browser  # real Chromium
def test_checkbox_and_radio_do_not_open_the_keyboard(app, tmp_path):
    body = ("def run(page, vd):\n"
            "    for sel in ('#agree', '#plan-a'):\n"
            "        page.locator(sel).click()\n"
            "        assert page.locator(sel).evaluate('el => el === document.activeElement')\n"
            "        assert page.locator('#__vd_keyboard').count() == 0, sel\n"
            "        assert page.evaluate('window.visualViewport.height') == 844, sel\n"
            "    vd.mark('ticked')\n")
    e = _run_kb(app, tmp_path, "kb-box", body)["iphone-13-pro"]
    assert e["error"] is None, e["error"]
    assert e["keyboard"] is True
    assert not any(c[0].startswith("keyboard-") for c in _checks(e))


def test_judge_prompt_explains_the_simulated_keyboard():
    import judge
    assert "SIMULATED on-screen" in judge.SYSTEM_PROMPT and "keyboard" in judge.SYSTEM_PROMPT


def test_every_marker_is_registered_by_the_copied_conftest():
    """Only `browser` is registered (conftest.py). A stray `live` passes here, where dante-config
    registers it, and then gets deselected or rejected in the repos the templates are copied to."""
    import re
    for f in (HERE / "vdebug_test.py", HERE / "judge_test.py", CAPTURE_DIR / "flowstore_test.py"):
        used = set(re.findall(r"@pytest\.mark\.(\w+)", f.read_text()))
        assert used <= {"browser", "parametrize"}, (f.name, used)


class _FakePage:
    """Just enough of a Playwright page for VD.mark(): `fail` names which evaluate() raises."""
    url = "http://x/"

    def __init__(self, fail):
        self.fail = fail

    def screenshot(self, path, full_page=False):
        pathlib.Path(path).write_bytes(b"")

    def evaluate(self, js):
        which = "layout" if js is vdebug.LAYOUT_CHECKS_JS else "fit"
        if which == self.fail:
            raise RuntimeError("Execution context was destroyed, most likely because of a navigation")
        return [] if which == "layout" else [3000, 844]


@pytest.mark.parametrize("fail", ["layout", "fit"])
def test_a_check_that_raises_is_reported_as_checks_failed(tmp_path, fail):
    """A navigating page can't be evaluated. The mark must record checks-failed, not crash the
    flow, and a failed layout evaluation must not also swallow the MUST_FIT guard (or vice versa)."""
    vp = vdebug.VIEWPORTS["iphone-13-pro"]
    vd = vdebug.VD(_FakePage(fail), "http://x", vp, tmp_path / "f" / vp.name, tmp_path, must_fit=True)
    vd.mark("m", settle=False)
    by = {c["check"]: c for c in vd.checks}
    assert set(by) == {"checks-failed", "below-fold"} - ({"below-fold"} if fail == "fit" else set())
    assert "Execution context was destroyed" in by["checks-failed"]["detail"]
    assert by["checks-failed"]["detail"].startswith("MUST_FIT") == (fail == "fit")
    assert by["checks-failed"]["frames"] == ["m"]


def _phone_probe(app, query, before=None, after=None, keyboard=True):
    """Open /keyboard<query> on an iPhone-sized touch page (with keyboard.js unless keyboard=False),
    run before(page), take the layout checks, run after(page). -> (hits, before_val, after_val)."""
    pytest.importorskip("playwright.sync_api")
    from playwright.sync_api import sync_playwright

    base, _ = app
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        if keyboard:
            ctx.add_init_script(vdebug.KEYBOARD_JS.replace("__VD_KB_HEIGHT__", "336"))
        page = ctx.new_page()
        page.goto(base + "/keyboard" + query)
        got_before = before(page) if before else None
        hits = {(h["check"], h["selector"]) for h in page.evaluate(vdebug.LAYOUT_CHECKS_JS)}
        got_after = after(page) if after else None
        b.close()
    return hits, got_before, got_after


def _focus(page, sel):
    page.evaluate("s => document.querySelector(s).focus({preventScroll: true})", sel)
    page.wait_for_timeout(150)  # keyboard.js scrolls in a requestAnimationFrame


@pytest.mark.browser  # real Chromium
@pytest.mark.parametrize("case,field,flagged,quiet", [
    # body{position:fixed} scroll lock: page content is not "pinned"; the real fixed bar still is
    ("lock", "#lock-field", {"#send"}, {"#lock-btn"}),
    # a fixed drawer's own scroller clips #sheet-more above the keyboard: scroll it into view
    ("sheet", "#sheet-field", {"#send"}, {"#sheet-more"}),
    # a full-screen player covers the page's bar: the keyboard isn't what hides it
    ("cover", "#player-search", {"#player-play"}, {"#send", "#draft"}),
])
def test_keyboard_covers_control_skips_what_is_reachable_or_already_covered(app, case, field, flagged, quiet):
    hits, _, _ = _phone_probe(app, f"?case={case}", before=lambda page: _focus(page, field))
    covered = {s for c, s in hits if c == "keyboard-covers-control"}
    assert flagged <= covered and not (quiet & covered), covered


@pytest.mark.browser  # real Chromium
def test_keyboard_scrolls_the_fields_own_scroller_and_never_leaves_page_scroll(app):
    state = "() => ({y: scrollY, drawer: document.getElementById('drawer')?.scrollTop})"
    # A field deep in a full-screen fixed drawer: scroll the DRAWER, never the page.
    hits, got, _ = _phone_probe(app, "?case=drawer", before=lambda page: (_focus(page, "#drawer-deep"),
                                                                        page.evaluate(state))[1])
    assert got["drawer"] > 0 and got["y"] == 0, got
    assert ("keyboard-covers-focus", "#drawer-deep") not in hits

    def fixed_then_page(page):
        _focus(page, "#msg")                 # fixed bar, no scroller: page scrolling can't help
        seen = [page.evaluate("scrollY")]
        page.evaluate("document.activeElement.blur()")
        page.wait_for_timeout(50)
        seen.append(page.evaluate("scrollY"))
        page.evaluate("window.scrollTo(0, document.getElementById('mid').getBoundingClientRect().top - 700)")
        seen.append(page.evaluate("scrollY"))  # #mid now sits at y=700, under the keyboard
        _focus(page, "#mid")
        seen.append(page.evaluate("scrollY"))
        page.evaluate("document.activeElement.blur()")
        page.wait_for_timeout(50)
        seen.append(page.evaluate("scrollY"))
        return seen
    _, (fixed_open, fixed_closed, start, opened, closed), _ = _phone_probe(app, "", before=fixed_then_page)
    assert fixed_open == 0 and fixed_closed == 0
    assert opened > start and closed == start   # the keyboard's own page scroll is undone on close


@pytest.mark.browser  # real Chromium
def test_keyboard_panel_sits_above_a_modal_dialog_and_stays_click_through(app):
    def open_dialog_over_keyboard(page):
        _focus(page, "#name")                                            # keyboard already up...
        page.evaluate("document.getElementById('dlg').showModal()")      # ...then a modal opens
        page.wait_for_timeout(150)
        # Painted on top? A modal makes the rest of the page (the panel too) inert, so hit tests
        # can't say. Compare pixels instead: with the panel above the dialog, removing the dimmed,
        # blurred ::backdrop changes nothing inside the keyboard area.
        spot = {"x": 150, "y": 830, "width": 40, "height": 10}
        dimmed = page.screenshot(clip=spot)
        page.add_style_tag(content="#dlg::backdrop { background: none !important; backdrop-filter: none !important }")
        on_top = page.screenshot(clip=spot) == dimmed
        return {**page.evaluate("""() => {
          const p = document.getElementById('__vd_keyboard');
          return {focus: document.activeElement.id, open: p.matches(':popover-open'), pe: getComputedStyle(p).pointerEvents};
        }"""), "onTop": on_top}

    def tap_save_under_keyboard(page):
        box = page.locator("#dlg-ok").bounding_box()
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        return page.evaluate("window.__dlgOk === true")
    hits, got, tapped = _phone_probe(app, "?case=modal", before=open_dialog_over_keyboard, after=tap_save_under_keyboard)
    assert got == {"focus": "dlg-field", "open": True, "pe": "none", "onTop": True}, got
    assert tapped                                        # pointer-events:none, even in the top layer
    assert ("keyboard-covers-control", "#dlg-ok") in hits   # a sheet's button under the keyboard: real
    # #under-dlg is page content right under the dialog's button: the dialog covering it is intended
    assert not any(c == "overlapping-controls" and s in ("#under-dlg", "#dlg-ok") for c, s in hits), hits


@pytest.mark.browser  # real Chromium
def test_overlapping_controls_ignores_closed_details_and_drawer_covered_controls(app):
    hits, _, _ = _phone_probe(app, "?case=overlap", keyboard=False)
    overlaps = {s for c, s in hits if c == "overlapping-controls"}
    assert "#cover-a" in overlaps                                   # #cover-b eats its taps: real
    assert not overlaps & {"#page-btn", "#drawer-btn", "#det-a", "#det-b"}, overlaps


@pytest.mark.browser  # real Chromium
def test_tap_target_invisible_input_and_zoom_checks_skip_their_false_positives(app):
    hits, _, _ = _phone_probe(app, "?case=targets", keyboard=False)
    assert ("invisible-hit-target", "#bare-ghost") in hits
    assert ("invisible-hit-target", "#pill-radio") not in hits      # custom radio pill: tap the label
    assert {("small-tap-target", "#view-link"), ("small-tap-target", "#tiny-on")} <= hits
    assert not {("small-tap-target", "#text-link"), ("small-tap-target", "#tiny-off")} & hits
    assert ("ios-input-zoom", "#note") in hits
    assert ("ios-input-zoom", "#side-search") not in hits           # collapsed sidebar, x=-264


@pytest.mark.browser  # real Chromium
def test_zoom_disabled_viewport_is_one_page_hit_instead_of_per_input_hits(app):
    hits, _, _ = _phone_probe(app, "?case=nozoom", keyboard=False)
    assert ("zoom-disabled", None) in hits
    assert not any(c == "ios-input-zoom" for c, _ in hits), hits
