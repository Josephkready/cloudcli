"""Start a new conversation and run one chat turn against the mock provider."""

from _helpers import boot, open_sidebar, visible

NAME = "new-chat-turn"
DESCRIPTION = ("'New conversation' -> folder picker -> type in 'Search folders…' to filter it "
               "(on iPhone/iPad the on-screen keyboard opens; the filtered list must stay above it) "
               "-> choose the project -> empty composer; type a prompt (keyboard up), send it "
               "(keyboard closes), and watch the (mock) assistant reply stream in")
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
    search.press_sequentially("bench", delay=20)
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
