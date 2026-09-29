"""Unknown route -> 404 page -> back to the app."""

NAME = "not-found"
DESCRIPTION = "Deep link to a route that does not exist -> 404 page -> follow its link back to the app"
SOURCE = "standard"
START = "/this/route/does-not-exist"


def run(page, vd):
    page.get_by_role("link").first.click()
    page.wait_for_url(lambda u: "does-not-exist" not in u)
    vd.mark("back in app")
