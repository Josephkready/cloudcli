import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * Guards the self-hosted web fonts (issue #270).
 *
 * The fonts moved out of a render-blocking fonts.googleapis.com stylesheet and
 * into `public/fonts/`, wired up by hand-written `@font-face` rules. Both halves
 * of that wiring fail *silently*:
 *
 *   - A typo in a `src: url(...)` filename does not error. The face simply never
 *     loads and every screen quietly renders in the system fallback, which looks
 *     close enough that it survives a casual glance at a screenshot.
 *   - Re-adding any off-host `<link>` to index.html restores exactly the failure
 *     mode the issue removed: first paint of a LAN/tailnet-only app blocking on
 *     the public internet being reachable.
 *
 * Neither is reachable from a rendering test (jsdom does not load fonts, and a
 * missing font file is indistinguishable from a fallback in the DOM), so these
 * assert against the source files directly.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const INDEX_HTML = readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
const INDEX_CSS = readFileSync(path.join(REPO_ROOT, 'src', 'index.css'), 'utf8');

interface FontFace {
    family: string;
    style: string;
    /** `[min, max]` — a single weight is stored as an equal pair. */
    weight: [number, number];
    url: string;
}

/** Strip `/* ... *\/` comments so commentary mentioning a URL can't fake a match. */
function stripCssComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Same idea for HTML: the comment above the preload names the old CDN hosts. */
function stripHtmlComments(html: string): string {
    return html.replace(/<!--[\s\S]*?-->/g, '');
}

function parseFontFaces(css: string): FontFace[] {
    const faces: FontFace[] = [];
    for (const block of stripCssComments(css).matchAll(/@font-face\s*\{([^}]*)\}/g)) {
        const body = block[1];
        const family = /font-family:\s*['"]?([^;'"]+)['"]?\s*;/.exec(body)?.[1].trim();
        const url = /src:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(body)?.[1].trim();
        assert.ok(family, `@font-face block has no font-family:\n${body}`);
        assert.ok(url, `@font-face block for ${family} has no src: url(...)`);

        const rawWeight = /font-weight:\s*([^;]+);/.exec(body)?.[1].trim() ?? '400';
        const bounds = rawWeight.split(/\s+/).map(Number);
        assert.ok(
            bounds.every((n) => Number.isFinite(n)),
            `${family} has a non-numeric font-weight descriptor: ${rawWeight}`,
        );

        faces.push({
            family,
            style: /font-style:\s*([^;]+);/.exec(body)?.[1].trim() ?? 'normal',
            weight: [bounds[0], bounds[bounds.length - 1]],
            url,
        });
    }
    return faces;
}

/** `<link rel="preload" ... as="font">` hrefs, in document order. */
function parsePreloadedFonts(html: string): string[] {
    const hrefs: string[] = [];
    for (const tag of html.matchAll(/<link\b[^>]*>/g)) {
        const raw = tag[0];
        if (!/rel=["']preload["']/.test(raw) || !/\bas=["']font["']/.test(raw)) {
            continue;
        }
        const href = /href=["']([^"']+)["']/.exec(raw)?.[1];
        assert.ok(href, `preloaded font link has no href: ${raw}`);
        hrefs.push(href);
    }
    return hrefs;
}

/** Resolve a root-relative CSS/HTML asset URL to its path under `public/`. */
function publicPathFor(url: string): string {
    return path.join(PUBLIC_DIR, url.replace(/^\//, ''));
}

const FONT_FACES = parseFontFaces(INDEX_CSS);
const PRELOADED = parsePreloadedFonts(INDEX_HTML);

test('index.html requests nothing off-host', () => {
    // The specific regression: the Google Fonts preconnects + stylesheet.
    assert.doesNotMatch(
        stripHtmlComments(INDEX_HTML),
        /fonts\.(googleapis|gstatic)\.com/,
        'index.html references Google Fonts again — self-hosted faces live in public/fonts',
    );

    // The general rule the issue actually asks for: no absolute-URL subresource
    // of any kind, so first paint can never depend on the public internet.
    const external = [...stripHtmlComments(INDEX_HTML).matchAll(/(?:href|src)=["'](https?:\/\/[^"']+)["']/g)]
        .map((match) => match[1]);
    assert.deepEqual(external, [], 'index.html loads off-host subresources');
});

test('every @font-face points at a file that exists in public/fonts', () => {
    assert.ok(FONT_FACES.length > 0, 'src/index.css declares no @font-face rules');

    for (const face of FONT_FACES) {
        assert.match(
            face.url,
            /^\/fonts\/[^/]+\.woff2$/,
            `${face.family} ${face.style} must load a self-hosted woff2, got ${face.url}`,
        );
        assert.ok(
            existsSync(publicPathFor(face.url)),
            `${face.family} ${face.style} points at ${face.url}, which does not exist under public/ ` +
                '— the face would silently fall back to a system font',
        );
    }
});

test('both font families used by tailwind.config.js are self-hosted', () => {
    // Tailwind's `font-sans`/`font-serif` (and `body` in index.css) name these
    // two; a rename on either side would strand the app on system fallbacks.
    for (const family of ['Encode Sans', 'Merriweather']) {
        assert.ok(
            FONT_FACES.some((face) => face.family === family),
            `no @font-face declares "${family}"`,
        );
    }

    // Merriweather is the chat serif and markdown emphasis renders italic, so
    // the italic face has to be there or the browser synthesises a slant.
    assert.ok(
        FONT_FACES.some((face) => face.family === 'Merriweather' && face.style === 'italic'),
        'Merriweather has no italic face — markdown emphasis would be faux-italic',
    );
});

test('declared weight ranges cover every weight the UI asks for', () => {
    // Tailwind's font-normal/medium/semibold/bold, which src/ uses throughout.
    const used = [400, 500, 600, 700];
    for (const family of ['Encode Sans', 'Merriweather']) {
        for (const weight of used) {
            const covered = FONT_FACES.some(
                (face) =>
                    face.family === family &&
                    face.style === 'normal' &&
                    weight >= face.weight[0] &&
                    weight <= face.weight[1],
            );
            assert.ok(covered, `no ${family} face covers weight ${weight} — it would be faux-bolded`);
        }
    }
});

test('only the first-paint face is preloaded', () => {
    assert.deepEqual(
        PRELOADED,
        ['/fonts/encode-sans-v23-latin.woff2'],
        'preload set changed — Encode Sans is the UI face needed for first paint, and ' +
            'Merriweather (chat serif) must stay unpreloaded so it cannot compete with it',
    );
});

test('preloaded fonts exist and are actually used by a @font-face', () => {
    const declared = new Set(FONT_FACES.map((face) => face.url));
    for (const href of PRELOADED) {
        assert.ok(existsSync(publicPathFor(href)), `preloaded ${href} does not exist under public/`);
        assert.ok(
            declared.has(href),
            `preloaded ${href} is not the src of any @font-face — it would download and go unused`,
        );
    }
});

test('preload links carry the attributes a font fetch needs', () => {
    for (const tag of INDEX_HTML.matchAll(/<link\b[^>]*rel=["']preload["'][^>]*>/g)) {
        const raw = tag[0];
        if (!/\bas=["']font["']/.test(raw)) {
            continue;
        }
        // Fonts are CORS-fetched even same-origin; without `crossorigin` the
        // preload is discarded and the file is downloaded a second time.
        assert.match(raw, /\bcrossorigin\b/, `font preload is missing crossorigin: ${raw}`);
        assert.match(raw, /type=["']font\/woff2["']/, `font preload is missing type: ${raw}`);
    }
});
