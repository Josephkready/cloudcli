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
