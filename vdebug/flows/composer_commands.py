"""The composer's autocomplete menus: '/' slash commands and '@' file mentions."""

from _helpers import boot, open_large_conversation, visible

NAME = "composer-commands"
DESCRIPTION = ("Open a conversation -> type '/' in the composer -> slash-command menu above it; narrow "
               "it to /help and press Enter -> the help dialog opens; type in 'Filter commands...' -> "
               "close -> type '@pack' in the composer -> file-mention menu narrowed to package.json; pick it with "
               "Enter -> the path is in the draft. On iPhone/iPad the on-screen keyboard is up the whole "
               "time: both menus and the help dialog's filter must stay above it")
SOURCE = "standard"
START = None

COMPOSER = '[data-slot="prompt-input-textarea"]'


def run(page, vd):
    boot(page, vd)
    open_large_conversation(page, vd)
    composer = visible(page.locator(COMPOSER))
    composer.click()
    composer.press_sequentially("/", delay=20)
    visible(page.get_by_text("/help", exact=True)).wait_for()
    vd.mark("slash menu")
    composer.press_sequentially("hel", delay=20)
    vd.mark("slash menu filtered")
    composer.press("Enter")                            # runs /help -> the command result dialog
    commands = visible(page.get_by_placeholder("Filter commands..."))
    commands.wait_for()
    vd.mark("help dialog")
    commands.click()
    commands.press_sequentially("model", delay=20)
    vd.mark("commands filtered")
    page.keyboard.press("Escape")
    commands.wait_for(state="detached")

    composer.click()
    composer.press_sequentially("Check @pack", delay=20)
    visible(page.get_by_text("package.json").last).wait_for()
    vd.mark("file mention menu")
    composer.press("Enter")
    page.wait_for_function(
        "sel => document.querySelector(sel).value.includes('package.json')", arg=COMPOSER)
    vd.mark("file mentioned")
