"""Start a new conversation and run one chat turn against the mock provider."""

import time

from _helpers import (boot, by_css, by_label, ios_boot, ios_open_sidebar, open_sidebar,
                      visible)

NAME = "new-chat-turn"
DESCRIPTION = ("'New conversation' -> folder picker -> type in 'Search folders…' to filter it "
               "(on iPhone/iPad the on-screen keyboard opens; the filtered list must stay above it) "
               "-> choose the project -> empty composer; type a prompt (keyboard up), send it "
               "(composer keeps focus, keyboard stays up), and watch the (mock) assistant reply stream in")
SOURCE = "standard"
START = None

COMPOSER = '[data-slot="prompt-input-textarea"]'


def run(page, vd):
    boot(page, vd)
    open_sidebar(page, vd)
    visible(page.get_by_role("button", name="New conversation")).click()
    page.locator("[cmdk-item]").first.wait_for()
    vd.mark("folder picker")
    # Filter by typing (#346: the picker lives in the fixed sidebar overlay, which must follow the
    # keyboard too). No autofocus by design (#366), so tap the search box first.
    search = visible(page.get_by_placeholder("Search folders…"))
    search.click()
    search.press_sequentially("primary", delay=20)
    vd.mark("folder search typed")
    visible(page.locator("[cmdk-item]")).click()
    composer = visible(page.locator(COMPOSER))
    composer.wait_for()
    vd.mark("empty composer")
    composer.fill("Summarise what the transcript loader does, briefly.")
    vd.mark("prompt typed")
    visible(page.get_by_role("button", name="Send")).click()
    page.get_by_text("the mock provider.").wait_for()
    visible(page.get_by_role("button", name="Send")).wait_for()
    vd.mark("reply complete")


def run_ios(device, vd):
    """The same new-chat path on a real iOS Simulator (standalone PWA), with native taps so the
    keyboard really opens for the folder search and the empty composer (#346, #442)."""
    app = ios_boot(device, vd)
    ios_open_sidebar(app, vd)
    app.tap(by_label("New conversation"), "'New conversation'")
    app.wait("document.querySelector('[cmdk-item]')", "the folder picker")
    vd.mark("folder picker")
    search = by_css('input[placeholder="Search folders…"]')
    app.tap(search, "the folder search box")
    app.wait("window.innerHeight - visualViewport.height > 150", "the on-screen keyboard")
    device.type_text("primary", selector='input[placeholder="Search folders…"]')
    time.sleep(0.8)
    vd.mark("folder search typed")
    app.check_not_covered(vd, by_css("[cmdk-item]"), "first folder result")
    app.tap(by_css("[cmdk-item]"), "the first folder result")
    app.wait(f"(() => {{ {by_css(COMPOSER)} }})()", "the empty composer")
    vd.mark("empty composer")
    app.tap(by_css(COMPOSER), "the composer")
    app.wait("window.innerHeight - visualViewport.height > 150", "the on-screen keyboard")
    time.sleep(0.8)
    app.check_not_covered(vd, by_css(COMPOSER), "composer")
    device.type_text("Summarise what the transcript loader does, briefly.", selector=COMPOSER)
    vd.mark("prompt typed")
    app.tap(by_label("Send"), "the Send button")
    app.wait("document.body.innerText.includes('the mock provider.')", "the mock reply")
    time.sleep(0.8)
    vd.mark("reply complete")
