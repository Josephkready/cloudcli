"""Tests for vdebug.py's pure helpers (viewport parsing/sizing, flow loading, exit codes,
report rendering, CLI wiring). No browser, no capture backend.

cloudcli's capture path is the Node/TS module under server/modules/vdebug-capture/ (with its
own vitest suite), not the Python flowstore.py template — so the template's `@pytest.mark.live`
tests that drive a real browser against a fixture app + flowstore round-trip are NOT ported
here; see the port report for what covers that instead. The `live` marker itself is still
registered (conftest.py) for any future test that wants to drive a real Chromium.
"""

import json
import pathlib
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parent
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


@pytest.mark.live  # real Chromium
@pytest.mark.parametrize("vp_name", ["iphone-13-pro", "ipad-pro-11"])
def test_tap_target_reads_the_after_overlay_on_touch_viewports(vp_name):
    hits = _tap_hits(vp_name)
    flagged = {sel.lstrip("#") for sel in hits}
    # bare 20x16 and the height-only overlay (20x44 — still under 24 wide) are real gaps;
    # the both-axes overlay (44x44) and a 32px-wide height-only overlay (32x44) are not.
    assert flagged == {"bare", "h-only"}, hits
    assert hits["#h-only"] == "hit area 20x44px (painted 20x16px) < 24x24"
    assert hits["#bare"] == "20x16px < 24x24"


@pytest.mark.live  # real Chromium
def test_tap_target_check_skips_mouse_desktop():
    assert _tap_hits("half-2k") == {}
