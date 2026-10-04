"""Reply in an existing conversation from a phone/tablet: the composer with the keyboard up."""

import time

from _helpers import (boot, by_css, by_label, ios_boot, ios_open_large_conversation,
                      open_large_conversation, visible)

NAME = "composer-keyboard"
DESCRIPTION = ("Open a long (~120-turn) conversation -> tap the message composer at the bottom "
               "(on iPhone/iPad the on-screen keyboard opens and the composer must stay visible "
               "above it) -> type a reply, then a second line with Shift+Enter (the composer grows) "
               "-> tap Send (the composer keeps focus, so the keyboard stays up by design) -> the mock "
               "assistant reply streams in above the composer")
SOURCE = "standard"
START = None

COMPOSER = '[data-slot="prompt-input-textarea"]'


def run(page, vd):
    boot(page, vd)
    open_large_conversation(page, vd)
    composer = visible(page.locator(COMPOSER))
    composer.wait_for()
    vd.mark("transcript loaded")
    composer.click()                                  # focus: the keyboard opens on touch presets
    vd.mark("composer focused")
    composer.press_sequentially("Why does the index boundary handler retry twice?", delay=15)
    vd.mark("reply typed")
    composer.press("Shift+Enter")
    composer.press_sequentially("Keep the answer short, please.", delay=15)
    vd.mark("multiline draft")
    visible(page.get_by_role("button", name="Send")).click()   # composer refocuses: keyboard stays up
    page.get_by_text("the mock provider.").last.wait_for()
    visible(page.get_by_role("button", name="Send")).wait_for()
    vd.mark("reply complete")


def run_ios(device, vd):
    """The same reply on a real iOS Simulator, launched from the home-screen icon (standalone),
    the only place #354-class keyboard bugs reproduce. Taps are native touches, so the keyboard
    really opens; each keyboard mark is followed by a check that the composer is not under it."""
    app = ios_boot(device, vd)
    ios_open_large_conversation(app, vd)
    app.wait(f"(() => {{ {by_css(COMPOSER)} }})()", "the composer")
    vd.mark("transcript loaded")
    app.tap(by_css(COMPOSER), "the composer")
    app.wait("window.innerHeight - visualViewport.height > 150", "the on-screen keyboard")
    time.sleep(0.8)                                   # let the keyboard animation and our re-layout settle
    vd.mark("composer focused")
    app.check_not_covered(vd, by_css(COMPOSER), "composer")
    device.type_text("Why does the index boundary handler retry twice?", selector=COMPOSER)
    vd.mark("reply typed")
    app.tap(by_label("Send"), "the Send button")
    app.wait("document.body.innerText.includes('the mock provider.')", "the mock reply")
    time.sleep(0.8)
    vd.mark("reply complete")
    app.check_not_covered(vd, by_css(COMPOSER), "composer")
