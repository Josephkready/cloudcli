"""Open a file from a transcript tool card, type into the code editor, discard the edit."""

from _helpers import boot, open_large_conversation, visible

NAME = "code-editor"
DESCRIPTION = ("Open a conversation -> tap the 'index.ts' file link on a Read tool card -> the code "
               "editor opens with src/index.ts -> tap into the code and type a new line (on iPhone/iPad "
               "the on-screen keyboard is up; the caret line must stay visible above it) -> Close -> "
               "'Unsaved changes' prompt -> Discard")
SOURCE = "standard"
START = None


def run(page, vd):
    boot(page, vd)
    open_large_conversation(page, vd)
    visible(page.get_by_role("button", name="index.ts").last).click()
    code = visible(page.get_by_role("textbox").and_(page.locator(".cm-content")))
    code.wait_for()
    visible(page.get_by_text("export function main")).wait_for()
    vd.mark("editor open")
    visible(page.get_by_text("export function main")).click()
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    page.keyboard.type("  // reviewed in vdebug", delay=15)
    vd.mark("line typed")
    visible(page.get_by_role("button", name="Close", exact=True)).click()
    discard = visible(page.get_by_role("button", name="Discard"))
    discard.wait_for()
    vd.mark("unsaved changes prompt")
    discard.click()
    code.wait_for(state="detached")
    vd.mark("editor closed")
