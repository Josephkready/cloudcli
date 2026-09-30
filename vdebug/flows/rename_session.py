"""Rename a conversation from the sidebar and from the chat header, cancelling both."""

from _helpers import LARGE_CONVERSATION, boot, open_sidebar, visible

NAME = "rename-session"
DESCRIPTION = ("Sidebar conversation row -> pencil ('Manually edit session name') -> inline field, type "
               "a new title, Escape cancels -> open the conversation -> where the header shows the title (not on phones), tap it "
               "('Click to rename') -> type a new title (on iPhone/iPad the on-screen keyboard is up; "
               "the header field must stay visible) -> Escape cancels")
SOURCE = "standard"
START = None


def run(page, vd):
    boot(page, vd)
    open_sidebar(page, vd)
    row = visible(page.get_by_role("link", name=LARGE_CONVERSATION))
    row.hover()
    visible(page.get_by_role("button", name="Manually edit session name")).click()
    field = visible(page.get_by_role("textbox", name="Manually edit session name"))
    field.wait_for()
    field.select_text()
    field.press_sequentially("Sidebar threshold notes", delay=15)
    vd.mark("sidebar rename typed")
    field.press("Escape")
    field.wait_for(state="detached")
    vd.mark("sidebar rename cancelled")

    visible(page.get_by_role("link", name=LARGE_CONVERSATION)).click()
    page.locator(".chat-message").first.wait_for()
    # Phones show the project name in the header, not the session title: no header rename there.
    header_title = page.get_by_title("Click to rename").filter(visible=True)
    if not header_title.count():
        return
    header_title.first.click()
    title = visible(page.get_by_label("Rename session"))
    title.wait_for()
    title.select_text()
    title.press_sequentially("Threshold migration — follow-up", delay=15)
    vd.mark("header rename typed")
    title.press("Escape")
    title.wait_for(state="detached")
    vd.mark("header rename cancelled")
