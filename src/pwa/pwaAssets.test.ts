import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * Guards the PWA install surface: the manifest, the iOS meta/link tags and the
 * service worker's caching strategy (issues #369, #372, #373).
 *
 * Every failure mode here is silent. A `sizes` value that disagrees with the
 * file behind it does not error — the browser just picks the icon by the size it
 * was promised and gets something else. A service worker that writes to Cache
 * Storage and never prunes looks identical to one that does, until iOS drops the
 * origin's storage. None of it is reachable from a rendering test, so these
 * assert against the shipped source files directly, the same way
 * src/styles/selfHostedFonts.test.ts does for the self-hosted faces.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const INDEX_HTML = readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
const SW_JS = readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(path.join(PUBLIC_DIR, 'manifest.json'), 'utf8')) as {
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

/** Strip `<!-- ... -->` so commentary describing a removed tag can't fake a match. */
function stripHtmlComments(html: string): string {
    return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Strip `//` and block comments so the prose explaining the old code can't fake
 * a match for the patterns below.
 *
 * Trailing comments are stripped too, not just whole-line ones: the assertions
 * here search for strings like `cache.put(` that the surrounding commentary
 * naturally mentions, so a future contributor writing
 * `something()  // do not reintroduce cache.put() here` would otherwise fail a
 * test by explaining it.
 *
 * The character class excludes `:` and the three quote characters so a `//`
 * that opens a URL (`https://…`) or sits inside a string literal (`'//legacy'`)
 * is not mistaken for a comment. That matters most for the registration walk
 * below, which runs this over the whole `src/` tree: over-stripping there would
 * silently swallow a real `serviceWorker.register(` that happened to share a
 * line with such a literal, defeating the one thing that test exists to catch.
 */
function stripJsComments(js: string): string {
    return js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/**
 * Intrinsic dimensions of a PNG, read straight from its IHDR chunk.
 *
 * A PNG is an 8-byte signature, then a 25-byte IHDR whose width and height are
 * big-endian uint32s at offsets 16 and 20. That is the whole parse — no image
 * library, which is the point: this test has to run in the same zero-dependency
 * `node --test` lane as the rest of src/.
 */
function pngSize(filePath: string): { width: number; height: number } {
    const bytes = readFileSync(filePath);
    assert.equal(
        bytes.subarray(0, 8).toString('hex'),
        '89504e470d0a1a0a',
        `${path.basename(filePath)} is not a PNG`,
    );
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Resolve a root-relative asset URL to its path under `public/`. */
function publicPathFor(url: string): string {
    return path.join(PUBLIC_DIR, url.replace(/^\//, ''));
}

/** `<link rel="apple-touch-icon">` tags, with their raw text for error messages. */
function appleTouchIcons(): { raw: string; href: string; sizes: string | undefined }[] {
    return [...stripHtmlComments(INDEX_HTML).matchAll(/<link\b[^>]*>/g)]
        .map((match) => match[0])
        .filter((raw) => /rel=["']apple-touch-icon(-precomposed)?["']/.test(raw))
        .map((raw) => {
            const href = /href=["']([^"']+)["']/.exec(raw)?.[1];
            assert.ok(href, `apple-touch-icon has no href: ${raw}`);
            return { raw, href, sizes: /sizes=["']([^"']+)["']/.exec(raw)?.[1] };
        });
}

test('every manifest icon is the size it claims to be', () => {
    assert.ok(MANIFEST.icons.length > 0, 'manifest declares no icons');

    for (const icon of MANIFEST.icons) {
        const file = publicPathFor(icon.src);
        assert.ok(existsSync(file), `manifest icon ${icon.src} does not exist under public/`);

        const { width, height } = pngSize(file);
        assert.equal(
            icon.sizes,
            `${width}x${height}`,
            `manifest declares ${icon.src} as ${icon.sizes} but the file is ${width}x${height} — ` +
                'Chrome flags the mismatch and some install paths skip the icon entirely',
        );
    }
});

test('the manifest declares both sizes Chrome requires to offer installation', () => {
    // Chrome's installability check (and Lighthouse's installable-manifest
    // audit) wants a 192x192 AND a 512x512 entry: 192 is the launcher/home
    // screen icon, 512 is the splash screen. Missing either one suppresses the
    // native install prompt entirely — the app can then only be installed
    // through the browser menu.
    //
    // This is the guard rail on the #369 fix. Trimming the manifest to only the
    // sizes that genuinely existed is right, but trimming past 192 would have
    // traded a cosmetic lie for a broken install button.
    const declared = new Set(MANIFEST.icons.map((icon) => icon.sizes));
    for (const required of ['192x192', '512x512']) {
        assert.ok(
            declared.has(required),
            `manifest declares no ${required} icon — Chrome will not offer to install the app`,
        );
    }
});

test('the manifest ships no duplicate icon entries', () => {
    // The regression this replaces: eight entries, eight different declared
    // sizes, one byte-identical 512x512 file behind all of them. Every icon must
    // be a genuinely distinct image, not a copy relabelled to fill a slot.
    assert.ok(MANIFEST.icons.length >= 2, 'too few icons for this check to mean anything');

    const sources = MANIFEST.icons.map((icon) => icon.src);
    assert.deepEqual(
        sources,
        [...new Set(sources)],
        'the same icon file is declared more than once',
    );

    const digests = new Set(
        MANIFEST.icons.map((icon) => readFileSync(publicPathFor(icon.src)).toString('base64')),
    );
    assert.equal(
        digests.size,
        MANIFEST.icons.length,
        'two manifest icons are byte-identical — they ship twice for one image',
    );
});

test('the largest maskable icon is big enough for the launcher to crop', () => {
    const maskable = MANIFEST.icons.filter((icon) => (icon.purpose ?? 'any').split(/\s+/).includes('maskable'));
    assert.ok(maskable.length > 0, 'no manifest icon declares purpose "maskable"');

    // Android's maskable spec crops to a circle inside the icon box, so the
    // largest declared maskable source has to be at least 512 or the launcher
    // upscales it.
    const widths = maskable.map((icon) => pngSize(publicPathFor(icon.src)).width);
    assert.ok(
        Math.max(...widths) >= 512,
        `largest maskable icon is ${Math.max(...widths)}px — below the 512 baseline`,
    );
});

test('apple-touch-icon links exist and never declare a size the file does not have', () => {
    const icons = appleTouchIcons();

    // src/App.tsx detects the router basename from icon link hrefs when the app
    // is served behind a path prefix, so removing the last one is not cosmetic.
    assert.ok(icons.length > 0, 'index.html declares no apple-touch-icon — App.tsx basename detection reads these');

    for (const icon of icons) {
        const file = publicPathFor(icon.href);
        assert.ok(existsSync(file), `apple-touch-icon points at ${icon.href}, which does not exist under public/`);

        if (icon.sizes === undefined) {
            continue; // No claim made, so none to break — iOS downscales.
        }
        const { width, height } = pngSize(file);
        assert.equal(
            icon.sizes,
            `${width}x${height}`,
            `apple-touch-icon declares ${icon.sizes} but ${icon.href} is ${width}x${height}: ${icon.raw}`,
        );
    }
});

test('iOS standalone meta tags are declared under both the standard and Apple names', () => {
    const html = stripHtmlComments(INDEX_HTML);
    for (const name of ['mobile-web-app-capable', 'apple-mobile-web-app-capable']) {
        assert.match(
            html,
            new RegExp(`<meta\\b[^>]*name=["']${name}["'][^>]*content=["']yes["']`),
            `index.html is missing <meta name="${name}" content="yes">`,
        );
    }
});

test('the service worker never writes hashed assets into Cache Storage', () => {
    // The leak in #372: a cache-first /assets/ branch put a fresh set of
    // content-hashed chunks into the cache on every deploy and pruned none. The
    // HTTP layer already serves those immutable for a year (see
    // IMMUTABLE_ASSET_PATTERN in server/middleware/compression.ts), so the Cache
    // Storage copy was pure growth.
    const code = stripJsComments(SW_JS);
    assert.doesNotMatch(
        code,
        /cache\.put\s*\(/,
        'sw.js writes to Cache Storage outside install — that is the unbounded-growth shape #372 removed',
    );
    assert.doesNotMatch(
        code,
        /['"`]\/assets\/['"`]|includes\(\s*['"`]\/assets\//,
        'sw.js special-cases /assets/ again',
    );
});

test('the service worker still purges caches it no longer owns', () => {
    const code = stripJsComments(SW_JS);
    assert.match(code, /addEventListener\(\s*['"]activate['"]/, 'sw.js has no activate handler');
    assert.match(
        code,
        /caches\.delete\(/,
        'activate no longer deletes anything — existing installs keep whatever earlier builds cached',
    );
});

test('the service worker precaches nothing that can go stale', () => {
    // Only the manifest, which PWA install needs. An HTML or JS entry here would
    // be served ahead of the network and pin clients to a dead build.
    const precached = /const urlsToCache\s*=\s*\[([^\]]*)\]/.exec(SW_JS)?.[1];
    assert.ok(precached !== undefined, 'sw.js no longer declares urlsToCache');

    const urls = [...precached.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
    assert.deepEqual(urls, ['/manifest.json'], 'sw.js precaches something other than the manifest');
});

test('the service worker is registered from exactly one place', () => {
    // Walks the whole front-end tree rather than checking two named files, so a
    // third registration site added anywhere — a new module, a Vite PWA plugin
    // wired into index.html — is caught too. Enumerating the known sites would
    // only ever re-confirm the two this PR already fixed.
    const roots = [path.join(REPO_ROOT, 'src'), path.join(REPO_ROOT, 'index.html')];
    const registering: string[] = [];

    const visit = (target: string): void => {
        const info = statSync(target);
        if (info.isDirectory()) {
            for (const entry of readdirSync(target)) {
                visit(path.join(target, entry));
            }
            return;
        }
        if (!/\.(html|js|jsx|ts|tsx|mjs)$/.test(target)) {
            return;
        }

        const raw = readFileSync(target, 'utf8');
        const source = target.endsWith('.html')
            ? stripJsComments(stripHtmlComments(raw))
            : stripJsComments(raw);
        if (/serviceWorker\s*\.\s*register\s*\(/.test(source)) {
            registering.push(path.relative(REPO_ROOT, target));
        }
    };
    roots.forEach(visit);

    assert.deepEqual(
        registering.sort(),
        ['src/main.jsx'],
        'service worker registration must live in src/main.jsx and nowhere else (#372)',
    );
});
