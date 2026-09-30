"""Add an allowed and a blocked tool rule in the Claude agent's permission settings."""

from _helpers import boot, open_settings, visible

NAME = "settings-permissions"
DESCRIPTION = ("Settings -> Agents -> Claude -> Permissions tab -> type an allowed-tool rule, press "
               "Enter (added to the list) -> scroll to Blocked Tools, type a rule, tap its Add button "
               "(added). On iPhone/iPad the on-screen keyboard is up while typing; the field and its "
               "Add button must stay visible above it")
SOURCE = "standard"
START = None


def run(page, vd):
    boot(page, vd)
    dialog = open_settings(page, vd, tab="Agents")
    visible(dialog.get_by_role("tab", name="Permissions")).click()
    allowed = visible(dialog.get_by_placeholder('e.g., "Bash(git log:*)" or "Write"'))
    allowed.wait_for()
    vd.mark("permissions")
    allowed.click()
    allowed.press_sequentially("Bash(npm test:*)", delay=15)
    vd.mark("allowed rule typed")
    allowed.press("Enter")
    visible(dialog.get_by_text("Bash(npm test:*)")).wait_for()
    vd.mark("allowed rule added")

    blocked = visible(dialog.get_by_placeholder('e.g., "Bash(rm:*)"'))
    blocked.click()
    blocked.press_sequentially("Bash(git push --force:*)", delay=15)
    vd.mark("blocked rule typed", show=blocked)
    visible(dialog.get_by_role("button", name="Add: Blocked Tools")).click()
    visible(dialog.get_by_text("Bash(git push --force:*)")).wait_for()
    vd.mark("blocked rule added")
