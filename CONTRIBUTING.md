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

CI also runs an **entry-chunk gate** after the suites. It builds the client and
inspects the emitted bundle, because the three test runners only see runtime
behaviour — which stays perfectly correct while a single stray static import
puts all ~290 Prism grammars or KaTeX's stylesheet back on the render-blocking
critical path (issues #268/#269):

```bash
npm run build:client && npm run check:bundle
npm run check:bundle:selftest   # the gate's own marker-matching self-tests
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
never overlap. Tailwind also excludes both suffixes from its `content` scan:
source-policy guards quote forbidden utility classes in their assertions, and
those test-only strings must not generate production CSS. Pick by what the test
needs:

- **No DOM needed** → `*.test.ts(x)` with `node:test`. Zero framework
  dependency, fastest feedback. This is still the default for pure logic.
- **A DOM, events, hooks, or effects** → `*.spec.ts(x)` with vitest. Also the
  only option for anything that transitively imports
  `src/shared/markdown/prismLanguages.ts` — which includes both markdown
  renderers, `src/components/chat/view/subcomponents/Markdown.tsx` and
  `src/components/code-editor/view/subcomponents/markdown/MarkdownPreview.tsx`.
  That module imports `react-syntax-highlighter`'s ESM build
  (`dist/esm/prism-light`, `dist/esm/languages/prism/*`, and the
  `dist/esm/styles/prism/one-{dark,light}` themes), whose CJS/ESM interop only
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

## Browser e2e (Playwright)

`npm run test:e2e` runs the Playwright browser suite in `e2e/` — separate from
the three unit runners above, with its own CI job
(`.github/workflows/e2e.yml`).

- One-time setup: `npx playwright install chromium`.
- It builds the client once (with `VITE_AUTH_DISABLED=true` baked in) and boots
  one server per worker with a throwaway DB and a temp HOME under `/var/tmp`,
  seeded over REST. Chat runs use the deterministic in-process mock provider
  (`AGENT_MOCK_PROVIDER=true`), so no real CLI/SDK, network, or credentials are
  needed. See `e2e/fixtures.ts` for the isolation details.
- Use e2e for full-app DOM/WebSocket flows — not as a substitute for
  unit-testing pure logic, which still belongs in the `node:test`/vitest
  runners above.

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

## Demand-loaded surfaces

Only the sidebar and the chat view are on the boot path. Everything else — the
shell, code editor, git panel, file tree, settings, onboarding, the project
wizard and the command palette — is behind `React.lazy` and ships in its own
chunk (issue #267). Before that split, xterm (~400 KB) and CodeMirror (~690 KB)
were parsed on every cold load even in a session that only read chat.

When you add or move one of these surfaces:

- Wrap it in `LazySurface` (`src/components/lazy/`), which pairs `Suspense`
  with the app's error boundary so a chunk that never arrives shows a message
  instead of blanking the app. Build the lazy component with `lazySurface(...)`
  rather than `lazy(...)` — it adds a retry, which matters because
  `React.lazy` memoises a rejected factory forever.
- Only *render* the lazy component when the surface is actually open. Mounting
  it is what triggers the import, so an unconditionally rendered lazy component
  that returns `null` defeats the whole thing.
- Keep the surface out of the eager import graph. `src/test/entryStaticImports.test.ts`
  walks the static imports from `src/main.jsx` and fails if xterm, CodeMirror,
  JSZip or DOMPurify become reachable without a dynamic `import()`, or if one of
  the named surfaces creeps back in. A type-only import (`import type { … }`) is
  fine — it is erased before the bundler sees it.
- If the chunk is big enough that fetching it at click time is felt, add its
  loader to `WARMABLE_SURFACES` in `src/components/lazy/surfaceLoaders.ts`. It
  is then imported during an idle callback after the load event, so the click
  is served from the module registry rather than the network.
