"""Reply in an existing conversation from a phone/tablet: the composer with the keyboard up."""

from _helpers import boot, open_large_conversation, visible

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
