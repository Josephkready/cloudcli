"""Search across conversations and open a hit."""

from _helpers import boot, open_sidebar, visible

NAME = "search-chats"
DESCRIPTION = ("Sidebar 'Search chats' -> type a query -> grouped results with highlighted "
               "snippets (on iPhone/iPad the on-screen keyboard is still up) -> open the 'Index boundary "
               "budget handler' match (not the first hit; tapping it closes the keyboard)")
SOURCE = "standard"
START = None


def run(page, vd):
    boot(page, vd)
    open_sidebar(page, vd)
    visible(page.get_by_role("button", name="Search chats")).click()
    vd.mark("search mode")
    search = page.get_by_role("textbox").filter(visible=True).first
    search.click()
    search.press_sequentially("migration", delay=20)   # keyboard up on iPhone/iPad
    page.wait_for_timeout(1500)
    vd.mark("results")
    visible(page.get_by_text("Index boundary budget handler (40 turns)")).click()
    page.get_by_text("bench-marker-", exact=False).first.wait_for()
    vd.mark("opened hit")
