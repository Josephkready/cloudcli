# App icons

## What ships today

CloudCLI's PWA icons live in `public/icons/` and there are **three**, all
resampled from the same 512x512 source artwork:

| file | declared in | used for |
|---|---|---|
| `icon-192x192.png` | `manifest.json` | launcher / home screen, and required for Chrome to offer installation |
| `icon-512x512.png` | `manifest.json` | splash screen, and the maskable source Android crops |
| `icon-180x180.png` | `index.html` `apple-touch-icon` | iOS home screen |

Chrome's installability check wants **both** a 192x192 and a 512x512 entry in the
manifest. Dropping either one silently removes the native install prompt, so
neither is optional. `src/pwa/pwaAssets.test.ts` pins that, and also asserts that
every declared `sizes` matches the file's real dimensions — the bug that prompted
this rewrite was eight declared sizes backed by eight byte-identical 512x512
copies (issue #369).

**Do not add a size by copying another file and renaming it.** The test reads the
PNG header and will reject it. Browsers downscale a larger icon perfectly well,
so extra sizes buy nothing and cost a build artifact each.

## Regenerating them

Resample from `icon-512x512.png`, which is the source of record:

```bash
cd public/icons
python3 - <<'PY'
from PIL import Image
src = Image.open('icon-512x512.png').convert('RGBA')
for size in (192, 180):
    src.resize((size, size), Image.LANCZOS).save(f'icon-{size}x{size}.png', optimize=True)
PY
```

Then run `npx tsx --tsconfig tsconfig.json --test "src/pwa/*.test.ts"` to confirm
the manifest and the files still agree.

## The unused SVGs

`public/icons/icon-*.svg` and `public/generate-icons.js` are **not part of the
build and nothing references them.** They are a different, unshipped design — a
purple rounded square with a MessageSquare glyph — from an icon rework that was
never completed. The PNGs in this directory are a dark full-bleed mark instead.

They are kept only as a design artifact. Running `generate-icons.js` rewrites
those SVGs and changes nothing the app loads. Converting them to PNG would
**replace the app's icon with a different design**, which is a visual change that
wants a human decision, not a build step.

## Launch images (iOS)

`public/icons/launch/` holds the `apple-touch-startup-image` set declared in
`index.html` (issue #373). iOS has no manifest-driven splash: without an image
matching the device's exact geometry AND orientation, an installed home-screen
app shows a blank white screen for the whole cold start. A near-miss does not
apply — it falls back to the blank screen — which is why there are thirty of
them.

They are **generated**, from the same `icon-512x512.png` that backs the app
icons:

```bash
python3 scripts/generate-launch-images.py
```

It rewrites the directory and prints the `<link>` tags to paste into
`index.html`. Re-run it after changing the source artwork; the mark is keyed out
of the icon rather than redrawn, so there is no second copy of the design to keep
in sync.

The background is the manifest's `background_color`, not a light/dark pair.
`prefers-color-scheme` does work in these media queries, but honouring it doubles
both the files and the `<link>` tags in `<head>` — and this app self-hosts its
fonts specifically to keep first paint off the network, so unconditional head
markup is not free. `pwaAssets.test.ts` asserts the generator's `BACKGROUND` and
the manifest's `background_color` have not drifted apart.

## Install screenshots

`public/icons/screenshots/` backs the manifest's `screenshots`, which is what
makes Chrome show its richer install dialog instead of the minimal one. They are
real pictures of the running app, captured by an opt-in e2e spec:

```bash
CAPTURE_PWA_SCREENSHOTS=1 npx playwright test e2e/pwa-screenshots.spec.ts --project=chromium
```

That boots a real server with a seeded project and the deterministic mock
provider, so the conversation in the shot is reproducible. The spec is skipped
without the env var, because it writes binaries into `public/`. Re-capture when
the chat surface changes enough that the install dialog would be showing a lie.
