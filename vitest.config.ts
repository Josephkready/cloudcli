import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.js';

/**
 * Component-test runner.
 *
 * This is a *second* runner, not a replacement: the existing `node:test` suites
 * (`*.test.ts`/`*.test.tsx`, run by `tsx --test`) stay exactly as they are and
 * keep covering pure logic with zero transform cost. Vitest owns the files named
 * `*.spec.ts`/`*.spec.tsx`, which is what keeps the two globs from overlapping.
 *
 * The app's own `vite.config.js` is reused wholesale so tests resolve the `@`
 * alias, the React plugin's JSX transform, and — critically — the same
 * dependency interop the app gets. That last part is why components importing
 * `react-syntax-highlighter/dist/esm/styles/prism` (the Markdown chain) can be
 * tested here but crash the raw Node ESM loader used by `tsx --test`.
 */
export default defineConfig((configEnv) =>
  mergeConfig(viteConfig(configEnv), {
    test: {
      environment: 'jsdom',
      // `*.test.*` is intentionally excluded — those belong to `npm run test:unit`.
      include: ['src/**/*.spec.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
      restoreMocks: true,
      css: false,
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.spec.{ts,tsx}', 'src/**/*.test.{ts,tsx}', 'src/test/**'],
        // `text-summary` keeps CI logs readable while the suite is young (a
        // per-file `text` table would be ~370 rows of 0%); the HTML report is
        // there for local drill-down; `lcov` writes `coverage/component/lcov.info`,
        // the machine-readable report the coverage floor gate parses (see
        // scripts/check-coverage-floor.mjs).
        reporter: ['text-summary', 'html', 'lcov'],
        reportsDirectory: 'coverage/component',
      },
    },
  }),
);
