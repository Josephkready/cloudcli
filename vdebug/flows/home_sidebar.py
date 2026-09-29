"""Boot the app, open the sidebar, expand spaces and filter the project list."""

import re

from _helpers import boot, open_sidebar, visible

NAME = "home-sidebar"
DESCRIPTION = ("App boot -> project chooser; open the sidebar (drawer on small screens), "
               "expand the Spaces list, then type into 'Search projects' to filter it")
SOURCE = "standard"
START = None


def run(page, vd):
    boot(page, vd)
    open_sidebar(page, vd)
    visible(page.get_by_role("button", name="Toggle spaces")).click()
    vd.mark("spaces expanded")
    visible(page.get_by_role("textbox", name="Search projects...")).fill("workspace")
    # Each space row shows "<n> sessions"; "workspace" leaves exactly one space.
    counts = page.get_by_text(re.compile(r"^\d+ sessions")).filter(visible=True)
    for _ in range(50):
        if counts.count() == 1:
            break
        page.wait_for_timeout(100)
    else:
        raise AssertionError("project search did not filter the Spaces list")
    # The filter is debounced (useSidebarController debouncedSearchQuery); let it apply.
    page.wait_for_timeout(1000)
    vd.mark("projects filtered")
