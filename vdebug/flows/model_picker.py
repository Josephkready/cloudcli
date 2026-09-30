"""Pick the model for a new conversation through the searchable model dialog."""

import re

from _helpers import boot, open_sidebar, visible

NAME = "model-picker"
DESCRIPTION = ("'New conversation' -> choose the project -> empty chat with the provider card -> tap it "
               "('Click to change model') -> 'Choose a model' dialog (a bottom sheet on phones) -> type "
               "in 'Search models...' (on iPhone/iPad the on-screen keyboard is up; the filtered list "
               "must stay above it) -> pick the match -> the card shows the new model")
SOURCE = "standard"
START = None


def run(page, vd):
    boot(page, vd)
    open_sidebar(page, vd)
    visible(page.get_by_role("button", name="New conversation")).click()
    visible(page.locator("[cmdk-item]").filter(has_text="bench-primary")).click()
    card = visible(page.get_by_role("button", name=re.compile("Click to change model")))
    card.wait_for()
    vd.mark("provider card")
    card.click()
    search = visible(page.get_by_placeholder("Search models..."))
    search.wait_for()
    vd.mark("model dialog")
    search.click()
    search.press_sequentially("haiku", delay=20)
    vd.mark("models filtered")
    visible(page.get_by_role("option", name=re.compile("haiku", re.I))).click()
    search.wait_for(state="detached")
    visible(page.get_by_role("button", name=re.compile(r"Haiku.*Click to change model", re.I))).wait_for()
    vd.mark("model chosen")
