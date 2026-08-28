# End-to-end performance benchmark

Measures how long cloudcli's core journeys take, from the click to the pixels,
against a seeded library that looks like a real user's machine.

```bash
npm run bench                                              # run everything, print a table
npm run bench -- --label baseline --out bench/results/baseline.json
npm run bench -- --label after --compare bench/results/baseline.json
npm run bench -- --only switch_to_large_conversation --iterations 15
npm run bench -- --diff bench/results/before.json bench/results/after.json   # no measuring
npm run bench -- --help
```

One-time setup: `npx playwright install chromium` (shared with the e2e suite).

| flag | meaning |
| --- | --- |
| `--profile small\|standard\|large` | Fixture size (default `standard`) |
| `--seed <n>` | Fixture PRNG seed (default `20260815`) |
| `--iterations <n>` | Measured iterations per flow (default 7) |
| `--warmup <n>` | Discarded iterations per flow (default 2) |
| `--label <name>` | Label recorded in the report |
| `--only <a,b>` | Run only these flows |
| `--out <file>` | Write the full JSON report |
| `--markdown <file>` | Write a Markdown summary |
| `--compare <file>` | Print this run against a previous JSON report |
| `--diff <before> <after>` | Diff two saved reports and exit — measures nothing |
| `--skip-build` | Reuse the existing `dist/` (must be auth-disabled) |
| `--headed` | Show the browser |

`--diff` is the one to reach for on a shared machine: measure both commits back
to back, save each with `--out`, then render the comparison afterwards.

## What it measures

| flow | the journey |
| --- | --- |
| `app_boot` | Cold load until the composer and conversation list are usable |
| `new_conversation` | Sidebar "New conversation" → folder picker → empty composer |
| `typing` | Main-thread work to type an 87-character message |
| `chat_turn` | Send → own message appears → first assistant token → run finishes → transcript reconciled, in a **new** conversation |
| `chat_turn_in_large_conversation` | The same turn, sent into a ~900-turn conversation |
| `switch_to_large_conversation` | Click a ~900-turn conversation → its transcript on screen |
| `switch_to_typical_conversation` | Same, for a ~24-turn conversation |
| `switch_back_warm` | Return to a conversation already loaded this session (the cache path) |
| `bug_report` | Open the reporter → the captured context renders |

The two chat-turn flows are deliberately both present. A turn in a new
conversation has almost no transcript to reconcile afterwards, so it is blind to
anything that scales with conversation length — which is most of what the
post-turn work does. A turn sent into a long conversation is where a user
actually spends their day, and where that cost shows up.

Every flow reports its steps separately, plus, per step, the API calls it made
and how long the main thread was blocked. That split is the point: it says
whether a slow step is the server's fault or the renderer's.

## How the timing works

Timing happens **inside the browser**, never from Node. A Playwright `click()`
costs a CDP round-trip of a few milliseconds — the same order as some of these
steps, and it moves with machine load. So the harness hands action and predicate
*source strings* to an instrument installed via `addInitScript`
(`bench/instrument.ts`), which:

- reads `performance.now()` immediately before dispatching the action,
- watches for the predicate with a `MutationObserver` plus a per-frame poll,
- and stops the clock on the animation frame that will paint the result.

Multi-checkpoint journeys (a chat turn is send → echo → token → complete →
settled) go through `__bench.sequence`, which arms every checkpoint before the
click lands. Splitting them into separate calls would lose any gap shorter than
a round-trip and report those checkpoints as ~0 ms.

Two numbers accompany each step:

- **blocked** — `longtask` time overlapping the step. Chromium-only, which is
  why the harness pins Chromium.
- **API** — every `fetch` started during the step, timed to the last byte of the
  body rather than to the headers, because a streamed 3 MB transcript is fast to
  header and slow to finish.

`typing` is the one flow that does not report wall-clock. Its number is the sum
of the per-keystroke spans — React flushes an `input` event synchronously, so
that span is the app's real per-key cost. Wall-clock there would be dominated by
the deliberate frame wait between keystrokes, i.e. by the display's cadence.

## The fixture

`bench/seed.ts` writes a throwaway HOME under `/var/tmp`: workspace folders, a
`~/.claude/projects/<encoded-cwd>/<id>.jsonl` per conversation, and a
`history.jsonl` name map. The server's own synchronizer discovers all of it, so
the fixture exercises the real indexing path.

It is **deterministic** — a seeded PRNG and a fixed base timestamp *inside* the
transcripts, so two runs at different commits read byte-identical files. File
mtimes are the deliberate exception: they are stamped an hour apart anchored to
*now*, because they only set sidebar ordering, and dating them months in the
past put them one advanced scan cursor away from never being indexed at all.
It is also **skewed** (one
900-turn conversation, one 300-turn, a long tail of 24-turn ones) because the
expensive paths only appear on the big ones. `--profile small|standard|large`
changes the sizes; `--compare` refuses to be quiet about a fixture mismatch.

Transcripts contain prose, fenced code, tool calls and results — assistant
replies are rendered through react-markdown and a syntax highlighter, so a
fixture of plain prose would make transcript rendering look far cheaper than it
is. Each conversation's final message carries a `bench-marker-<id>` string,
which is what the flows use to assert "*this* conversation's transcript is on
screen" — message count cannot tell two conversations apart, because the client
pages at 20 messages either way.

## Reading the numbers on a shared machine

Every flow here is sensitive to what else the machine is doing, and the failure
is silent: a run that overlaps a test suite, a build, or someone else's job
reports that contention as a regression in whichever flows happened to run
during it. That is not hypothetical — the first "after" run of this benchmark
showed `typing` 50% *slower* purely because a `vitest` suite was running
alongside it, while the flows that ran later, once it finished, showed the real
improvement.

Two things follow:

- **`--compare` prints the delta on both the median and the minimum.** The
  minimum is the fastest of the measured iterations — the closest available
  reading of "this code, with nothing in the way". When the two disagree, the
  median is usually describing the neighbours. A win visible in both is a real
  win; a win visible only in the minimum is a weaker claim and should be said
  that way.
- **Every report records the 1-minute load average** at the start and end of the
  run, and `--compare` prints both runs' figures above the table. Two reports
  taken at materially different load are not comparable, however tidy the
  percentages look.

If the box is not yours alone, measure both sides **back to back in the same
window** rather than comparing against a report from an hour ago: check the base
commit out into a second worktree, copy `bench/` into it, and alternate runs.

## What is in `bench/results/`

`before.json`, `after.json` and `comparison.md` are the run that justified the
optimisations landing alongside this harness — **an illustrative one-off
snapshot, not a maintained baseline.** They were taken on one machine, one
seed, one Chromium version, in one load window. Do not diff a fresh run against
them and read the result as a regression: re-measure both sides yourself, back
to back, as described above. They are committed because the claims in that PR
should be checkable, not because anything keeps them current.

## Notes and limits

- The server runs under `tsx`, as the e2e suite does, not from `dist-server/`.
  Constant overhead, identical on both sides of a comparison.
- The agent provider is the deterministic in-process mock
  (`AGENT_MOCK_PROVIDER=true`), so `chat_turn` measures the app's send →
  render → persist path with no model latency in it. The mock's `echo:` prefix
  is used to make it return a realistically-sized markdown reply.
- Bug-report *submission* is not measured: `POST /api/bug-report` shells out to
  an `issue-queue` binary that is not part of the app.
- Warmup iterations are discarded. The first pass pays for V8 tier-up, the HTTP
  connection, and the OS page cache for the transcript being read.
- `bench/stats.ts` is unit-tested (`bench/stats.test.ts`, run by `npm run
  test:unit`); the fixture generator's determinism is not, so a change to
  `seed.ts` that makes output vary between runs would invalidate comparisons
  without failing anything. Keep it deterministic by hand.
