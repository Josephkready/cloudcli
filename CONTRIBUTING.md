# Contributing

## Development

This project targets the Node version pinned in [`.nvmrc`](.nvmrc) (Node 22).
Install dependencies with `npm ci` (or `npm install`).

```bash
npm run dev        # run the server + client together
npm run server:dev # server only
npm run client     # client only
```

## Quality gate

Every pull request runs the same checks CI runs (see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Run them locally before
opening a PR:

```bash
npm run lint       # eslint over src/ and server/
npm run typecheck  # tsc --noEmit for both the client and server tsconfigs
npm test           # server tests, front-end unit tests, then component tests
```

`npm test` is `npm run test:server && npm run test:unit && npm run test:component`.
To see coverage summaries for all three:

```bash
npm run test:coverage
```

That is just `test:server:coverage`, `test:unit:coverage`, and
`test:component:coverage` in sequence — run whichever one you need on its own.
The first two use Node's built-in `--experimental-test-coverage`; the component
one uses vitest's v8 provider and also writes a browsable report to
`coverage/component/`.

### Coverage floor

Each coverage script also emits a machine-readable LCOV report
(`coverage/server.lcov`, `coverage/unit.lcov`,
`coverage/component/lcov.info`). CI runs a separate **Coverage floor** step that
parses those and fails the build if any suite's line coverage drops below its
floor:

```bash
npm run coverage:floor   # checks the reports left by test:coverage
npm run coverage:check   # test:coverage + coverage:floor in one go
```

The floors are per-suite and tunable in
[`scripts/check-coverage-floor.mjs`](scripts/check-coverage-floor.mjs):

| Suite | Floor | Notes |
| --- | --- | --- |
| server (node:test) | 80% | |
| front-end unit (node:test) | 85% | |
| front-end component (vitest) | 3% | Young suite — vitest instruments every `src/` file, so this ratchets up fast as specs land. |

**Ratchet the floors up as coverage grows.** When a suite's real coverage
climbs, raise its floor in the script, leaving a couple of points of headroom so
an unrelated PR isn't blocked by noise. Never lower a floor just to make a red
run pass — investigate the regression instead. The LCOV parser has self-tests
(`npm run coverage:floor:selftest`) that CI runs before trusting the gate.

## Two test runners, split by filename

| Suite | Files | Runner | Command |
| --- | --- | --- | --- |
| Backend | `server/**/*.test.{ts,js}` | `node:test` via `tsx` | `npm run test:server` |
| Front-end unit | `src/**/*.test.{ts,tsx}` | `node:test` via `tsx` | `npm run test:unit` |
| Front-end component | `src/**/*.spec.{ts,tsx}` | vitest + jsdom + RTL | `npm run test:component` |

The `.test` / `.spec` suffix is what routes a file to a runner, so the globs
never overlap. Pick by what the test needs:

- **No DOM needed** → `*.test.ts(x)` with `node:test`. Zero framework
  dependency, fastest feedback. This is still the default for pure logic.
- **A DOM, events, hooks, or effects** → `*.spec.ts(x)` with vitest. Also the
  only option for anything that transitively imports
  `src/components/chat/view/subcomponents/Markdown.tsx`: it pulls in
  `react-syntax-highlighter/dist/esm/styles/prism`, whose CJS/ESM interop only
  Vite's transform resolves — under `tsx --test` the module fails to load at
  all. Watch mode: `npm run test:component:watch`.

`vitest.config.ts` reuses the app's `vite.config.js` (aliases, React plugin,
dependency interop). `src/test/setup.ts` runs before every component spec: it
initialises i18next, registers `@testing-library/jest-dom` matchers, stubs the
browser APIs jsdom omits (`matchMedia`, `ResizeObserver`,
`IntersectionObserver`, scrolling, `navigator.clipboard`), and resets state
between tests (`localStorage`/`sessionStorage`, the `<html>` class list, fake
timers, and the rendered DOM). Add shared stubs there rather than hand-rolling
them per file; `src/test/setup.spec.ts` guards that they stay installed.

For the `node:test` (`*.test.ts`) side, `src/test/setup.ts`'s auto-install
model doesn't apply — there's no jsdom and no before-each hook. Instead,
`src/test/nodeStubs.ts` provides opt-in helpers a pure-logic test calls
directly: `withGlobals` (install/restore arbitrary `globalThis` keys, even on
throw), `createLocalStorage`/`withLocalStorage` (an in-memory `localStorage`
whose entries stay own-enumerable so `Object.keys(localStorage)` works), and
`makeTranslator` (a recording i18n `t()` stub). Prefer these over hand-rolling
the same `localStorage`/`window`/`t()` boilerplate; `src/test/nodeStubs.test.ts`
guards their behavior.

## Testing expectations

Changes should ship with tests on every tier they touch:

- **Backend logic** (parsing, validation, services, request handlers) gets
  `node:test` unit/integration tests under `server/`.
- **Front-end pure logic** (formatting, parsing, sorting, validation,
  reducers/state, geometry) gets a `node:test` unit test colocated as
  `*.test.ts(x)`.
- **Interactive components and hooks** (click → state change, keyboard nav,
  effects, focus) get a vitest component test colocated as `*.spec.ts(x)`,
  using React Testing Library's `render`/`renderHook` and `user-event`.

Presentational components with no behavior can still be covered cheaply with a
`renderToStaticMarkup` assertion in a `*.test.tsx` file; reach for the vitest
harness when static markup is not enough.

## `*.pure.ts` siblings

When a hook or store hides risky logic in module-private helpers, split those
helpers into a `<module>.pure.ts` sibling and leave the hook as a thin wrapper
that imports them. A `.pure.ts` module holds plain functions over plain data —
no React, no effects, no render harness — so most of it can be covered with
`node:test` in a `<module>.pure.test.ts` file. Existing examples:
`src/stores/useSessionStore.pure.ts` (message merge/dedup/ordering),
`src/hooks/useProjectsState.pure.ts`, `src/hooks/useUiPreferences.pure.ts`,
`src/components/chat/hooks/useSlashCommands.pure.ts`.

A pure helper may still read a browser global (e.g. a `localStorage`-backed
initial read). Keep it in the `.pure.ts` file, but cover that part in a
`.pure.spec.ts` vitest/jsdom file rather than `.pure.test.ts` — see
`useUiPreferences.pure.ts` (`readInitialPreferences`) and its
`useUiPreferences.pure.spec.ts` for the split.
