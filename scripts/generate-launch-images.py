#!/usr/bin/env python3
"""Generate iOS `apple-touch-startup-image` launch images (issue #373).

WHY THIS EXISTS. iOS has no manifest-driven splash screen. Without an
`apple-touch-startup-image` for the exact device resolution and orientation, an
installed home-screen app shows a blank white screen for the whole cold start —
which is also the moment the app is at its least ready to explain itself. Android
gets this from the manifest's `background_color` + icon for free; iOS wants one
pre-rendered PNG per device size per orientation, each gated by a media query.

RUN IT:

    python3 scripts/generate-launch-images.py

It rewrites `public/icons/launch/` and prints the `<link>` tags for `index.html`.
Requires Pillow, the same dependency `public/convert-icons.md` already documents
for resampling the app icons.

DESIGN NOTES.

*Background is the manifest's `background_color`.* Not the light-mode surface,
and not a per-scheme pair. iOS does support `prefers-color-scheme` inside these
media queries, but honouring it doubles an already large set of files AND doubles
the `<link>` tags in `<head>` — and this app deliberately self-hosts its fonts to
keep first paint off the network, so several KB of unconditional head markup on
every page load is not free. One background, matching the value the manifest
already declares for the Android splash, keeps the two platforms telling the same
story for a fraction of the weight.

*The glyph is keyed out of the app icon rather than re-drawn.* `icon-512x512.png`
is a white mark on a solid `#18181b` field. Pasting it whole would leave a
faintly visible square wherever the splash background differs, so the background
is converted to alpha and the mark is composited as pure white. That also means
this script follows the icon: re-run it after changing the source artwork and the
splashes match, with no second copy of the design to keep in sync.
"""

from __future__ import annotations

import pathlib
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover - operator-facing
    sys.exit("Pillow is required: pip install Pillow")

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON_SOURCE = REPO_ROOT / "public" / "icons" / "icon-512x512.png"
OUTPUT_DIR = REPO_ROOT / "public" / "icons" / "launch"

# Must match `background_color` in public/manifest.json. `pwaAssets.test.ts`
# asserts they agree, so a change here without a change there fails the suite.
BACKGROUND = (20, 20, 20)  # #141414

# Fraction of the SHORTER screen edge the mark occupies. Sized off the short edge
# so the mark is identical in portrait and landscape.
MARK_FRACTION = 0.28

# (css_width, css_height, device_pixel_ratio, label)
#
# One entry per distinct CSS-pixel geometry, not per marketing name: iOS matches
# on `device-width`/`device-height`/`-webkit-device-pixel-ratio`, so devices that
# share a geometry share an image. Ordered oldest to newest.
DEVICES: list[tuple[int, int, int, str]] = [
    (375, 667, 2, "iPhone SE (2nd/3rd gen), 8"),
    (414, 896, 2, "iPhone XR, 11"),
    (375, 812, 3, "iPhone X, XS, 11 Pro, 12/13 mini"),
    (414, 896, 3, "iPhone XS Max, 11 Pro Max"),
    (390, 844, 3, "iPhone 12, 13, 14"),
    (428, 926, 3, "iPhone 12/13 Pro Max, 14 Plus"),
    (393, 852, 3, "iPhone 14 Pro, 15, 15 Pro, 16"),
    (430, 932, 3, "iPhone 14 Pro Max, 15 Plus/Pro Max, 16 Plus"),
    (402, 874, 3, "iPhone 16 Pro"),
    (440, 956, 3, "iPhone 16 Pro Max"),
    (768, 1024, 2, "iPad 9.7\""),
    (810, 1080, 2, "iPad 10.2\""),
    (820, 1180, 2, "iPad Air 10.9\""),
    (834, 1194, 2, "iPad Pro 11\""),
    (1024, 1366, 2, "iPad Pro 12.9\""),
]


def load_mark() -> Image.Image:
    """The app mark as white-on-transparent, keyed out of the shipped icon."""
    icon = Image.open(ICON_SOURCE).convert("RGBA")
    field = icon.getpixel((0, 0))[:3]

    def luminance(rgb: tuple[int, int, int]) -> float:
        return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]

    field_luma = luminance(field)
    span = max(1.0, 255.0 - field_luma)

    pixels = list(icon.getdata())
    keyed = []
    for red, green, blue, alpha in pixels:
        # Distance from the icon's own field, in luminance. Antialiased edges
        # land between 0 and 1 and become partial alpha, so the mark keeps its
        # smooth edges instead of turning into a hard-keyed stencil.
        weight = (luminance((red, green, blue)) - field_luma) / span
        weight = max(0.0, min(1.0, weight))
        keyed.append((255, 255, 255, int(round(weight * (alpha / 255.0) * 255))))

    marked = Image.new("RGBA", icon.size)
    marked.putdata(keyed)
    return marked.crop(marked.getbbox() or (0, 0, *icon.size))


def render(mark: Image.Image, width: int, height: int) -> Image.Image:
    """One splash: the flat background with the mark centred."""
    canvas = Image.new("RGBA", (width, height), (*BACKGROUND, 255))

    target = int(min(width, height) * MARK_FRACTION)
    scale = target / max(mark.width, mark.height)
    scaled = mark.resize(
        (max(1, round(mark.width * scale)), max(1, round(mark.height * scale))),
        Image.LANCZOS,
    )

    canvas.alpha_composite(
        scaled,
        ((width - scaled.width) // 2, (height - scaled.height) // 2),
    )
    # Palette, not truecolour: these are a flat field plus a white mark, so the
    # only colours present are the background and the mark's antialiased edge
    # ramp. 64 entries covers that exactly and roughly halves the bytes, which
    # matters when there are thirty of them at device resolution.
    return canvas.convert("RGB").quantize(colors=64, method=Image.MEDIANCUT)


def media_query(css_width: int, css_height: int, ratio: int, orientation: str) -> str:
    return (
        f"(device-width: {css_width}px) and (device-height: {css_height}px) "
        f"and (-webkit-device-pixel-ratio: {ratio}) and (orientation: {orientation})"
    )


def main() -> None:
    mark = load_mark()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for stale in OUTPUT_DIR.glob("*.png"):
        stale.unlink()

    tags: list[str] = []
    for css_width, css_height, ratio, label in DEVICES:
        for orientation in ("portrait", "landscape"):
            # The media query always describes the device in its natural
            # portrait geometry; only the IMAGE is rotated for landscape. That
            # is what iOS matches on, and getting it backwards is the usual way
            # these silently never apply.
            pixel_width = css_width * ratio
            pixel_height = css_height * ratio
            if orientation == "landscape":
                pixel_width, pixel_height = pixel_height, pixel_width

            name = f"launch-{pixel_width}x{pixel_height}.png"
            render(mark, pixel_width, pixel_height).save(
                OUTPUT_DIR / name, format="PNG", optimize=True
            )
            tags.append(
                f'    <link rel="apple-touch-startup-image" '
                f'media="{media_query(css_width, css_height, ratio, orientation)}" '
                f'href="/icons/launch/{name}" />  <!-- {label} -->'
            )

    print(f"wrote {len(tags)} images to {OUTPUT_DIR.relative_to(REPO_ROOT)}\n")
    print("\n".join(tags))


if __name__ == "__main__":
    main()
