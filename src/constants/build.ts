/**
 * Build identity for the running client bundle.
 *
 * scripts/dante-build.sh exports VITE_BUILD_SHA / VITE_BUILT_AT at build time and
 * vite.config.js inlines them via `define` (__CLOUDCLI_BUILD_SHA__ / __CLOUDCLI_BUILT_AT__).
 * The server reads the same SHA from dist/build-info.json at startup and serves it from
 * /health; useVersionCheck treats a mismatch as "a new build is deployed" (#458).
 *
 * This fork ships by ansible-pull from origin/main with no version bumps, so package.json's
 * semver is identical across deploys and cannot detect a stale tab — the SHA is the only
 * per-deploy identity that changes.
 *
 * Both are guarded with `typeof` because the identifiers only exist in a Vite build; unit
 * tests (tsx --test) and any non-Vite runtime see empty strings.
 */
export const BUILD_SHA: string = typeof __CLOUDCLI_BUILD_SHA__ === 'string' ? __CLOUDCLI_BUILD_SHA__ : '';
export const BUILT_AT: string = typeof __CLOUDCLI_BUILT_AT__ === 'string' ? __CLOUDCLI_BUILT_AT__ : '';
