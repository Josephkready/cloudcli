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
    id?: string;
    start_url?: string;
    orientation?: string;
    background_color?: string;
    display?: string;
    display_override?: string[];
    launch_handler?: { client_mode?: string };
    shortcuts?: { name: string; url: string; icons?: { src: string; sizes: string }[] }[];
    share_target?: { action: string; method: string; params: Record<string, string> };
    screenshots?: { src: string; sizes: string; type: string; form_factor?: string; label?: string }[];
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

/* ------------------------------------------------------------------ */
/*  Install quality: shortcuts, share target, screenshots (issue #370) */
/* ------------------------------------------------------------------ */

test('the manifest declares an explicit id', () => {
    // Without `id`, app identity is derived from `start_url` — so changing
    // `start_url` later installs a SECOND app beside the first rather than
    // updating it, and every installed copy is orphaned. It is one line now and
    // unfixable afterwards.
    assert.ok(MANIFEST.id, 'manifest has no "id"');
});

test('the installed app is not locked to one orientation', () => {
    // A locked orientation cannot be overridden by the user, and this app's main
    // surfaces are a terminal, a file tree, a diff and an editor — all of which
    // are legitimately useful in landscape on a phone and on any tablet.
    assert.notEqual(
        MANIFEST.orientation,
        'portrait-primary',
        'orientation is hard-locked to portrait; use "any" and let the device rotation lock decide',
    );
});

test('shortcuts point at real in-app routes and reuse a real icon', () => {
    const shortcuts = MANIFEST.shortcuts ?? [];
    assert.ok(shortcuts.length > 0, 'manifest declares no shortcuts');

    for (const shortcut of shortcuts) {
        assert.ok(shortcut.name, 'a shortcut has no name');
        assert.ok(shortcut.url.startsWith('/'), `shortcut url must be root-relative: ${shortcut.url}`);

        for (const icon of shortcut.icons ?? []) {
            const file = publicPathFor(icon.src);
            assert.ok(existsSync(file), `shortcut icon ${icon.src} does not exist under public/`);
            const { width, height } = pngSize(file);
            assert.equal(
                icon.sizes,
                `${width}x${height}`,
                `shortcut icon declares ${icon.sizes} but ${icon.src} is ${width}x${height}`,
            );
        }
    }
});

test('the New conversation shortcut asks for a new conversation', () => {
    // The URL is the whole contract: nothing calls into the app, so a shortcut
    // pointing at a bare "/" would just reopen wherever the user already was.
    // `src/pwa/launchParams.ts` parses this parameter and `useLaunchIntent` acts
    // on it — if the parameter name drifts, the shortcut silently does nothing.
    const shortcut = (MANIFEST.shortcuts ?? []).find((entry) => /new/i.test(entry.name));
    assert.ok(shortcut, 'no shortcut named for starting a new conversation');
    assert.match(
        shortcut.url,
        /[?&]new=1(&|$)/,
        `the new-conversation shortcut must carry ?new=1, got ${shortcut.url}`,
    );
});

test('the share target routes into the app with the parameters it parses', () => {
    const share = MANIFEST.share_target;
    assert.ok(share, 'manifest declares no share_target');

    // GET, because the app is a static SPA behind the API server: a POST share
    // target would need a service-worker fetch handler to catch it, and the
    // service worker here is deliberately network-first with no POST handling.
    assert.equal(share.method.toUpperCase(), 'GET');
    assert.ok(share.action.startsWith('/'), `share_target action must be root-relative: ${share.action}`);

    // These names are the contract with `parseLaunchParams`.
    assert.deepEqual(share.params, {
        title: 'share_title',
        text: 'share_text',
        url: 'share_url',
    });
});

test('every declared screenshot exists at the size it claims', () => {
    const screenshots = MANIFEST.screenshots ?? [];
    assert.ok(screenshots.length > 0, 'manifest declares no screenshots');

    for (const shot of screenshots) {
        const file = publicPathFor(shot.src);
        assert.ok(existsSync(file), `screenshot ${shot.src} does not exist under public/`);

        const { width, height } = pngSize(file);
        assert.equal(
            shot.sizes,
            `${width}x${height}`,
            `screenshot declares ${shot.sizes} but ${shot.src} is ${width}x${height} — Chrome drops the richer install dialog on a mismatch`,
        );
    }
});

test('screenshots cover both form factors, which is what unlocks the rich install UI', () => {
    // Chrome only shows the richer install dialog when it has a screenshot for
    // the form factor it is installing on. One of each is the minimum that
    // actually buys anything.
    const factors = new Set((MANIFEST.screenshots ?? []).map((shot) => shot.form_factor));
    for (const required of ['wide', 'narrow']) {
        assert.ok(factors.has(required), `no screenshot declares form_factor "${required}"`);
    }
});

/* ------------------------------------------------------------------ */
/*  iOS launch images (issue #373)                                     */
/* ------------------------------------------------------------------ */

/** `<link rel="apple-touch-startup-image">` tags with their media query. */
function launchImages(): { raw: string; href: string; media: string }[] {
    return [...stripHtmlComments(INDEX_HTML).matchAll(/<link\b[^>]*>/g)]
        .map((match) => match[0])
        .filter((raw) => /rel=["']apple-touch-startup-image["']/.test(raw))
        .map((raw) => {
            const href = /href=["']([^"']+)["']/.exec(raw)?.[1];
            const media = /media=["']([^"']+)["']/.exec(raw)?.[1];
            assert.ok(href, `apple-touch-startup-image has no href: ${raw}`);
            assert.ok(media, `apple-touch-startup-image has no media query: ${raw}`);
            return { raw, href, media };
        });
}

test('iOS launch images are declared at all', () => {
    // Without these an installed iOS app shows a blank white screen for the
    // whole cold start — iOS has no manifest-driven splash to fall back on.
    assert.ok(launchImages().length > 0, 'index.html declares no apple-touch-startup-image');
});

test('every launch image exists and is exactly the resolution its media query implies', () => {
    for (const image of launchImages()) {
        const file = publicPathFor(image.href);
        assert.ok(existsSync(file), `launch image ${image.href} does not exist under public/`);

        const width = Number(/\(device-width:\s*(\d+)px\)/.exec(image.media)?.[1]);
        const height = Number(/\(device-height:\s*(\d+)px\)/.exec(image.media)?.[1]);
        const ratio = Number(/\(-webkit-device-pixel-ratio:\s*(\d+)\)/.exec(image.media)?.[1]);
        const isLandscape = /orientation:\s*landscape/.test(image.media);
        assert.ok(
            Number.isFinite(width) && Number.isFinite(height) && Number.isFinite(ratio),
            `launch image media query is missing device metrics: ${image.raw}`,
        );

        // The media query always describes the device in portrait; only the
        // image is rotated. Getting that backwards is the usual way these
        // silently never apply, and iOS gives no diagnostic — it just shows the
        // blank screen this exists to remove.
        const expected = isLandscape
            ? { width: height * ratio, height: width * ratio }
            : { width: width * ratio, height: height * ratio };

        const actual = pngSize(file);
        assert.deepEqual(
            actual,
            expected,
            `${image.href} is ${actual.width}x${actual.height} but its media query implies ${expected.width}x${expected.height}`,
        );
    }
});

test('each launch image declares both orientations for its device', () => {
    // A device with only a portrait image shows the blank screen when launched
    // in landscape, which is exactly the bug being fixed — half-fixed.
    const byDevice = new Map<string, Set<string>>();
    for (const image of launchImages()) {
        const device = /\(device-width:\s*(\d+)px\)\s*and\s*\(device-height:\s*(\d+)px\)\s*and\s*\(-webkit-device-pixel-ratio:\s*(\d+)\)/.exec(image.media);
        assert.ok(device, `unparseable launch media query: ${image.media}`);
        const key = `${device[1]}x${device[2]}@${device[3]}`;
        const orientation = /orientation:\s*(portrait|landscape)/.exec(image.media)?.[1];
        assert.ok(orientation, `launch image declares no orientation: ${image.raw}`);
        byDevice.set(key, (byDevice.get(key) ?? new Set()).add(orientation));
    }

    for (const [device, orientations] of byDevice) {
        assert.deepEqual(
            [...orientations].sort(),
            ['landscape', 'portrait'],
            `device ${device} is missing a launch image for one orientation`,
        );
    }
});

test('no two launch images are byte-identical for different resolutions', () => {
    // The #369 failure mode, one directory over: a set of files that look like a
    // complete matrix but are one image copied under many names.
    const images = launchImages();
    const bySize = new Map<string, string>();
    for (const image of images) {
        const { width, height } = pngSize(publicPathFor(image.href));
        const key = `${width}x${height}`;
        const existing = bySize.get(key);
        if (existing) {
            assert.equal(existing, image.href, `two different files both claim ${key}`);
            continue;
        }
        bySize.set(key, image.href);
    }
    assert.ok(bySize.size > 1, 'every launch image is the same resolution');
});

test('the launch images use the background colour the manifest promises', () => {
    // iOS shows the launch image; Android composites `background_color`. If they
    // disagree the same app flashes two different colours on two platforms, and
    // the whole point of the launch image is that the start looks deliberate.
    assert.ok(MANIFEST.background_color, 'manifest declares no background_color');

    const generator = readFileSync(
        path.join(REPO_ROOT, 'scripts', 'generate-launch-images.py'),
        'utf8',
    );
    const declared = /BACKGROUND\s*=\s*\((\d+),\s*(\d+),\s*(\d+)\)/.exec(generator);
    assert.ok(declared, 'could not read BACKGROUND out of the launch-image generator');

    const hex = `#${[declared[1], declared[2], declared[3]]
        .map((channel) => Number(channel).toString(16).padStart(2, '0'))
        .join('')}`;
    assert.equal(
        hex,
        MANIFEST.background_color!.toLowerCase(),
        'the generator background and the manifest background_color have drifted',
    );
});
