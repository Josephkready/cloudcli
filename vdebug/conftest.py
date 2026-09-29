"""Registers the `live` marker the vdebug tests use (real Chromium / real ffmpeg), so the
tests run cleanly under --strict-markers in any repo. Merge into your conftest if you have one."""


def pytest_configure(config):
    config.addinivalue_line("markers", "live: drives a real browser (Playwright/Chromium)")
