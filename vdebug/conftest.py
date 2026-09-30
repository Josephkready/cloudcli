"""Registers the markers the vdebug tests use, so they run cleanly under --strict-markers.

`live` is this repo's original name for "drives a real browser"; the synced template tests use
`browser` for the same thing (and still `live` in a few keyboard tests), so both are registered.
Deselect with `-m "not live and not browser"` where Playwright isn't installed."""


def pytest_configure(config):
    config.addinivalue_line("markers", "live: drives a real browser (Playwright/Chromium)")
    config.addinivalue_line("markers", "browser: drives a real browser (Playwright/Chromium)")
