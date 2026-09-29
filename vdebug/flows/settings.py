"""Open Settings and move between its sections."""

from _helpers import boot, open_sidebar, visible

NAME = "settings"
DESCRIPTION = "Open Settings (modal) -> Agents tab -> Appearance -> About -> close"
SOURCE = "standard"
START = None


def run(page, vd):
    boot(page, vd)
    open_sidebar(page, vd)
    visible(page.get_by_role("button", name="Settings")).click()
    dialog = visible(page.get_by_role("dialog"))
    dialog.wait_for()
    vd.mark("settings open")
    visible(dialog.get_by_role("button", name="Appearance")).click()
    vd.mark("appearance")
    visible(dialog.get_by_role("button", name="About")).click()
    vd.mark("about")
    page.keyboard.press("Escape")
    vd.mark("closed")
