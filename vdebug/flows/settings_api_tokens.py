"""Fill the API-key and GitHub-token forms in Settings, cancelling both."""

from _helpers import boot, open_settings, visible

NAME = "settings-api-tokens"
DESCRIPTION = ("Settings -> 'API & Tokens' -> 'New API Key' -> type a key name -> Cancel -> GitHub "
               "Tokens 'Add Token' -> type a token name, the token (tap 'Show token' to reveal it) and "
               "a description -> Cancel. On iPhone/iPad the on-screen keyboard is up while typing; "
               "every field must stay visible above it (nothing is saved)")
SOURCE = "standard"
START = None


def run(page, vd):
    boot(page, vd)
    dialog = open_settings(page, vd, tab="API & Tokens")
    vd.mark("api & tokens")
    visible(dialog.get_by_role("button", name="New API Key")).click()
    key_name = visible(dialog.get_by_placeholder("API Key Name (e.g., Production Server)"))
    key_name.click()
    key_name.press_sequentially("Build server", delay=15)
    vd.mark("api key name typed")
    visible(dialog.get_by_role("button", name="Cancel")).click()
    key_name.wait_for(state="detached")

    visible(dialog.get_by_role("button", name="Add Token")).click()
    token_name = visible(dialog.get_by_placeholder("Token Name (e.g., Personal Repos)"))
    token_name.click()
    token_name.press_sequentially("Personal repos", delay=15)
    token = visible(dialog.get_by_placeholder("GitHub Personal Access Token (ghp_...)"))
    token.click()
    token.press_sequentially("ghp_exampleexampleexample", delay=10)
    visible(dialog.get_by_role("button", name="Show token")).click()
    description = visible(dialog.get_by_placeholder("Description (optional)"))
    description.click()
    description.press_sequentially("Read-only, expires in 90 days", delay=15)
    vd.mark("github token typed")
    visible(dialog.get_by_role("button", name="Cancel")).click()
    token_name.wait_for(state="detached")
    vd.mark("forms cancelled")
