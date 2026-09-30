"""Registers the `browser` marker the vdebug tests use (they drive real Chromium via Playwright).

Deliberately NOT `live`: many repos use `live` for "hits a real external API" and deselect it
by default, which would silently skip these. cloudcli's earlier port used `live` for the same
thing; since video-debugger #560 every browser test here is `browser`, and
test_every_marker_is_registered_by_the_copied_conftest keeps it that way. Deselect with
`-m "not browser"` where Playwright isn't installed."""


def pytest_configure(config):
    config.addinivalue_line("markers", "browser: drives a real browser (Playwright/Chromium)")
