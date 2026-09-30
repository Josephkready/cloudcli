"""Rename a project inline in the sidebar, then cancel."""

from _helpers import boot, open_sidebar, project_action, visible

NAME = "rename-project"
DESCRIPTION = ("Sidebar project row -> Rename (pencil) -> the name becomes an inline text field "
               "(on iPhone/iPad the on-screen keyboard is up; the row must stay visible above it) "
               "-> replace the name -> Escape cancels and the original name is back")
SOURCE = "standard"
START = None

PROJECT = "bench-workspace-1"


def run(page, vd):
    boot(page, vd)
    open_sidebar(page, vd)
    project_action(page, PROJECT, "Rename")
    field = visible(page.get_by_placeholder("Project name"))
    field.wait_for()
    vd.mark("rename field")
    field.click()        # the field sits inside the row's <button>: a click must not toggle the row
    field.select_text()
    field.press_sequentially("Payments service (renamed)", delay=15)
    vd.mark("new name typed")
    field.press("Escape")
    field.wait_for(state="detached")
    vd.mark("rename cancelled")
