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
npm test           # server tests, then front-end unit tests
```

`npm test` is `npm run test:server && npm run test:unit`. To see a coverage
summary (Node's built-in `--experimental-test-coverage`, no extra deps):

```bash
npm run test:coverage
```

## Testing expectations

Changes should ship with tests on every tier they touch:

- **Backend logic** (parsing, validation, services, request handlers) gets
  `node:test` unit/integration tests under `server/`.
- **Front-end pure logic** (formatting, parsing, sorting, validation,
  reducers/state, geometry) gets a `node:test` unit test colocated as
  `*.test.ts(x)`. Present components are covered with
  `renderToStaticMarkup` snapshots of the rendered markup.

Interactive DOM behavior (click → state change) is not yet unit-testable — a
component-test harness (vitest + jsdom + RTL) is tracked separately. Prefer
extracting pure logic so it can be tested today.

Tests run with Node's built-in runner via `tsx`; no test framework dependency
is required.
