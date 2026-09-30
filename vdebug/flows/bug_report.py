"""Open the in-app bug reporter from a conversation (never submits)."""

from _helpers import boot, open_large_conversation, visible

NAME = "bug-report"
DESCRIPTION = ("From an open conversation, tap the bug icon -> reporter dialog with the captured "
               "context -> type a description (on iPhone/iPad with the on-screen keyboard up; the field "
               "and dialog must stay usable above it) -> tap Show to expand the attached session details (the report is NOT sent)")
SOURCE = "standard"
START = None


def run(page, vd):
    boot(page, vd)
    open_large_conversation(page, vd)
    visible(page.get_by_role("button", name="Report a bug")).click()
    dialog = visible(page.get_by_role("dialog"))
    dialog.wait_for()
    vd.mark("reporter open")
    what = dialog.get_by_label("What happened?")
    what.click()                                       # keyboard opens on iPhone/iPad
    what.press_sequentially("The transcript jumped while scrolling up.", delay=10)
    vd.mark("description typed")
    dialog.get_by_role("button", name="Show").click()
    page.get_by_test_id("bug-report-metadata-row").first.wait_for()
    vd.mark("session details expanded")
