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
/**
 * `COVERAGE_WHOLE_APP=1` swaps the coverage scope for scripts/coverage-all.mjs:
 * every app file in src/, server/ and shared/ gets an executable-line count
 * (vitest instruments files it never executes), written to its own directory
 * so the component floor gate's `coverage/component` report keeps measuring
 * the vitest suite alone.
 */
const wholeApp = process.env.COVERAGE_WHOLE_APP === '1';

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
        include: wholeApp
          ? ['src/**/*.{ts,tsx,js,jsx}', 'server/**/*.{ts,js}', 'shared/**/*.{ts,js}']
          : ['src/**/*.{ts,tsx}'],
        exclude: [
          '**/*.spec.{ts,tsx,js,jsx}',
          '**/*.test.{ts,tsx,js,jsx}',
          '**/*.d.ts',
          'src/test/**',
        ],
        // `text-summary` keeps CI logs readable while the suite is young (a
        // per-file `text` table would be ~370 rows of 0%); the HTML report is
        // there for local drill-down; `lcov` writes `coverage/component/lcov.info`,
        // the machine-readable report the coverage floor gate parses (see
        // scripts/check-coverage-floor.mjs).
        reporter: ['text-summary', 'html', 'lcov'],
        reportsDirectory: wholeApp ? 'coverage/whole-app' : 'coverage/component',
      },
    },
  }),
);
