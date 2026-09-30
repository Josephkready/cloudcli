"""Create a project with the wizard (every field typed into), then remove it again."""

import re
import time

from playwright.sync_api import expect

from _helpers import boot, expand_spaces, open_sidebar, project_action, visible

NAME = "create-project"
DESCRIPTION = ("Sidebar 'Create new project' -> wizard; type a GitHub URL (a token field appears), "
               "type a token, then clear the URL -> 'Browse folders' -> 'Create new folder', type its "
               "name (on iPhone/iPad the on-screen keyboard is up for every field; the dialog must "
               "stay usable above it) -> Next -> review -> Create Project -> the new project appears "
               "in the sidebar -> remove it (confirm modal) so the fixture is unchanged")
SOURCE = "standard"
START = None


def run(page, vd):
    boot(page, vd)
    open_sidebar(page, vd)
    visible(page.get_by_role("button", name="Create new project", exact=True)).click()
    wizard = visible(page.get_by_role("dialog"))
    wizard.wait_for()
    vd.mark("wizard open")

    github = wizard.get_by_placeholder("https://github.com/username/repository")
    github.click()
    github.press_sequentially("https://github.com/example/demo", delay=10)
    token = wizard.get_by_placeholder(re.compile(r"^ghp_"))
    token.click()
    token.press_sequentially("ghp_example", delay=10)
    vd.mark("clone details typed")
    github.fill("")                                   # back to an empty project: no clone
    token.wait_for(state="detached")

    wizard.get_by_role("button", name="Browse folders").click()
    visible(page.get_by_role("button", name="Create new folder")).click()
    folder = f"vdebug-{int(time.time() * 1000) % 10**8}"   # folders persist; never reuse a name
    name = visible(page.get_by_placeholder("New folder name"))
    name.click()
    name.press_sequentially(folder, delay=10)
    vd.mark("new folder named")
    visible(page.get_by_role("button", name="Create", exact=True)).click()
    expect(wizard.get_by_placeholder("/path/to/project/workspace")).to_have_value(
        re.compile(rf"/{folder}$"))
    vd.mark("workspace path filled")

    wizard.get_by_role("button", name="Next").click()
    vd.mark("review")
    wizard.get_by_role("button", name="Create Project").click()
    wizard.wait_for(state="detached")
    open_sidebar(page, vd, label="sidebar reopened")
    expand_spaces(page)
    visible(page.get_by_test_id(re.compile(r"^sidebar-project-row(-mobile)?$")).filter(
        has_text=folder)).wait_for()
    vd.mark("project created")

    project_action(page, folder, "Remove")
    visible(page.get_by_role("button", name="Delete all data permanently")).wait_for()
    vd.mark("remove confirm")
    visible(page.get_by_role("button", name="Delete all data permanently")).click()
    page.get_by_test_id(re.compile(r"^sidebar-project-row(-mobile)?$")).filter(
        has_text=folder).first.wait_for(state="detached")
    vd.mark("project removed")
