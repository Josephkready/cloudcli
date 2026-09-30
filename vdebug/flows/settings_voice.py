"""Turn on voice input and fill in the speech backend fields."""

from _helpers import boot, open_settings, visible

NAME = "settings-voice"
DESCRIPTION = ("Settings -> Voice -> toggle 'Enable voice' on -> the backend fields appear -> type the "
               "Base URL, API key and the speech-to-text / text-to-speech / voice / format fields (on "
               "iPhone/iPad the on-screen keyboard is up; each field must stay visible above it as the "
               "form scrolls) -> toggle voice off again")
SOURCE = "standard"
START = None

FIELDS = [
    ("Base URL", "https://api.groq.com/openai/v1"),
    ("API key", "gsk_example"),
    ("Speech-to-text model", "whisper-large-v3-turbo"),
    ("Text-to-speech model", "playai-tts"),
    ("Voice", "Fritz-PlayAI"),
    ("Audio format", "wav"),
]


def run(page, vd):
    boot(page, vd)
    dialog = open_settings(page, vd, tab="Voice")
    toggle = visible(dialog.get_by_role("switch", name="Enable voice"))
    toggle.click()
    visible(dialog.get_by_label("Base URL")).wait_for()
    vd.mark("voice enabled")
    for label, value in FIELDS:
        field = visible(dialog.get_by_label(label, exact=True))
        field.click()
        field.fill("")
        field.press_sequentially(value, delay=8)
        if label in ("API key", "Audio format"):
            vd.mark(f"{label.lower()} typed")
    toggle.click()
    dialog.get_by_label("Base URL").wait_for(state="detached")
    vd.mark("voice disabled")
