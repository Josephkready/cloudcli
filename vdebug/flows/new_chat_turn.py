"""Start a new conversation and run one chat turn against the mock provider."""

from _helpers import boot, open_sidebar, visible

NAME = "new-chat-turn"
DESCRIPTION = ("'New conversation' -> folder picker -> choose a project -> empty composer; "
               "type a prompt, send it, and watch the (mock) assistant reply stream in")
SOURCE = "standard"
START = None

COMPOSER = '[data-slot="prompt-input-textarea"]'


def run(page, vd):
    boot(page, vd)
    open_sidebar(page, vd)
    visible(page.get_by_role("button", name="New conversation")).click()
    page.locator("[cmdk-item]").first.wait_for()
    vd.mark("folder picker")
    page.locator("[cmdk-item]").first.click()
    composer = visible(page.locator(COMPOSER))
    composer.wait_for()
    vd.mark("empty composer")
    composer.fill("Summarise what the transcript loader does, briefly.")
    vd.mark("prompt typed")
    visible(page.get_by_role("button", name="Send")).click()
    page.get_by_text("the mock provider.").wait_for()
    visible(page.get_by_role("button", name="Send")).wait_for()
    vd.mark("reply complete")
