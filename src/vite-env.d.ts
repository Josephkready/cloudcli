/// <reference types="vite/client" />

// Build identity inlined by Vite `define` (see vite.config.js). Absent outside a Vite
// build (unit tests, non-Vite runtimes), so consumers must guard with `typeof`.
declare const __CLOUDCLI_BUILD_SHA__: string | undefined;
declare const __CLOUDCLI_BUILT_AT__: string | undefined;
