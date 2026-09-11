# Chat UI Architecture Assessment — 2026-09

**Question asked:** the chat surface feels choppier than ChatGPT/Gemini/Codex web —
streaming, scrolling, and long-transcript handling all feel worse. Is the stack
(TypeScript/JavaScript) the cause, and would a front-end rewrite fix it?

**Short answer:** no. The stack is not the problem — ChatGPT's web app is also a
React SPA streaming markdown over a socket, so "React/TypeScript" cannot be why
this feels worse. The measured problem is narrower and already partially fixed
once by this team: certain per-message-tick work in the transcript pipeline
scales with **total conversation size** rather than with the size of the turn
being rendered, so main-thread blocking during a live stream grows with how
long the conversation already is. A rewrite is not needed to fix this; four
targeted, bounded changes to the existing React/TypeScript code are.

This document is evidence-based: every claim below cites a file:line or a
measured number, most from the repository's own committed benchmark harness
(`bench/`), which the team built and used to fix an earlier instance of exactly
this class of bug.

---

## 1. Stack inventory

| Layer | Technology | Notes |
| --- | --- | --- |
| Front end | React 18 + Vite + TypeScript, Tailwind CSS | `src/` |
| Back end | Node.js + Express + `ws` WebSocket server | `server/` |
| Agent integration | `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, Antigravity CLI | `server/claude-sdk.js`, `server/openai-codex.js`, `server/antigravity-cli.js` |
| Storage | better-sqlite3 + append-only JSONL transcripts | |
| Markdown | `react-markdown` + `remark-gfm`, lazy KaTeX, lazy Mermaid, lazy Prism | `src/components/chat/view/subcomponents/Markdown.tsx` |
| Terminal / editor | xterm.js, CodeMirror 6 | code-split, not on the chat boot path |
| Tests | `node --test` (server, unit), Vitest (component), Playwright (e2e + perf bench) | |

**Language ratio** (`find src server shared -name '*.ts*' \| wc -l` vs `*.js*`):

| Area | TypeScript files | JavaScript files | TS share |
| --- | ---: | ---: | ---: |
| `src/` (front end) | 604 | 8 | 98.7% |
| `server/` (back end) | 212 | 48 | 81.5% |
| `shared/` | 1 | 1 | 50% |
| **Total** | **817** | **57** | **93.5%** |

The back end is TypeScript-first but not TypeScript-only: `server/tsconfig.json`
sets `allowJs: true` with a comment stating this is a deliberate, incremental
JS→TS migration (`checkJs: false`, "the backend is still mostly JavaScript
today"). The largest remaining plain-JS files are the provider integrations —
`server/claude-sdk.js`, `server/openai-codex.js`, `server/antigravity-cli.js`,
`server/cli.js` — which is exactly where a language-driven bug class (a bad
`any`, a missed null check across a provider boundary) would most plausibly
live. Nothing in this assessment traces a chat-UI symptom to that boundary, so
it is noted as residual risk, not as the cause investigated here.

**Fork/upstream drift** (`git remote -v`, `git rev-list --left-right --count
main...upstream/main`):

- `origin` = `Josephkready/cloudcli`, `upstream` = `siteboon/claudecodeui`.
- Local `main` is **242 commits ahead** of the merge-base with upstream (real
  feature/bugfix work, including most of the chat-perf hardening cited below)
  and **41 commits behind** `upstream/main` (not the ~20 estimated in the
  project's own todos).
- Local `package.json` version is `1.36.3`; upstream's latest tag is `v1.37.3`.

This matters for the rewrite-vs-fix decision in §4: a rewrite forfeits the
ability to keep merging upstream, and 242 commits is a large amount of
already-paid-for hardening to walk away from.

---

## 2. Methodology

The repository already contains a purpose-built Playwright performance harness
(`bench/`, added in commit `8f493a1a`, "perf: e2e benchmark harness + four
measured session/chat fixes") that does precisely what this assessment was
asked to do by hand: it drives real Chromium against a seeded, deterministic
fixture (6 projects, 54 conversations, 7,402 transcript rows, one 2,511-row/
1.5 MB conversation), instruments `performance.now()` + `MutationObserver` +
Chromium `longtask` entries via `addInitScript`, and reports median/p95/min
wall-clock plus main-thread-**blocked** time per step, split from network
(`fetch`) time.

Given that this instrumentation already exists, is more rigorous than a
one-off script would be in the time available, and is checkable by anyone who
runs `npm run bench`, this assessment **reused it** rather than writing a
parallel Playwright script. Three data points are cited:

1. **`bench/results/before.json`** — commit `eaa5e446` (pre-optimization).
2. **`bench/results/after.json`** — commit `8f493a1a` (post the team's own
   four fixes), committed to the repo as "an illustrative one-off snapshot."
3. **A fresh run at current `HEAD` (`efd6ab4e`)**, 6 commits after `8f493a1a`,
   run for this assessment: `npm run bench -- --only chat_turn,
   chat_turn_in_large_conversation,switch_to_large_conversation,
   switch_to_typical_conversation,app_boot --iterations 6 --warmup 2`.

**Caveat on (3):** it ran on the shared dante host at 1-minute load average
≈20 on 16 cores — the bench README explicitly warns that contention inflates
wall-clock and especially p95 on a shared machine. Medians and, more
importantly, **blocked-ms** (which is `longtask` time, not scheduling delay)
are far less sensitive to that noise and are what this assessment relies on;
wall-clock p95 from run (3) should not be read as a regression.

**What was not done, and why:** a live-app run against the deployed
`cloudcli.service` on dante was not performed — it needs an authenticated
session and the bench fixture's controlled, repeatable transcript sizes are a
better apples-to-apples comparison than one live conversation. A side-by-side
capture of ChatGPT/Gemini's own streaming performance was also skipped: it
would tell us those apps are also React/streaming/markdown-based (already true
by public knowledge — not in dispute), but not tell us anything about *this*
codebase's specific bottleneck, which is the actual question.

---

## 3. Measurements

All times in ms. "Blocked" = Chromium `longtask` time inside the step (main
thread was busy, not idle waiting on network).

| Flow / step | before (`eaa5e446`) | after (`8f493a1a`) | HEAD (`efd6ab4e`, noisy host) |
| --- | ---: | ---: | ---: |
| `chat_turn` (empty conversation) `first_token_to_complete` — median / **blocked** | 254.2 / **0** | 262.8 / **0** | 504.1 / **124*** |
| `chat_turn_in_large_conversation` (2,511-row) `first_token_to_complete` — median / **blocked** | 925.5 / **785** | 660.2 / **533** | 1366.2 / **428*** |
| `switch_to_large_conversation` `click_to_transcript` — median | 378.4 | 352.1 | 373.4 |
| `switch_to_typical_conversation` (85-row) `click_to_transcript` — median | 284.3 | 213.9 | 277.8 |
| `app_boot` `navigation_to_interactive` — median | 456.2 | 376.4 | 505.5* |
| Entry JS chunk (gzip) | — | — | **236 KB** (`dist/assets/index-*.js`, 801 KB raw) |
| `vendor-codemirror` chunk (gzip, lazy) | — | — | 242 KB |
| `vendor-xterm` chunk (gzip, lazy) | — | — | 101 KB |
| `mermaidRuntime` chunk (gzip, lazy) | — | — | 158 KB |
| Component (chat/UI) test coverage | — | — | **~4.3%**, floor **3%** |
| Unit (hooks/pure-logic) test coverage | — | — | ~87.8%, floor 85% |
| Server test coverage | — | — | ~82.7%, floor 80% |

\* HEAD numbers were captured under host load average ≈20/16 cores; treat as
order-of-magnitude corroboration, not a precise regression measurement.

**The key isolating comparison:** `chat_turn` and `chat_turn_in_large_conversation`
send the **identical** mock reply content (`fillComposer(..., `echo:${ECHOED_REPLY}`)`
in both flow definitions, `bench/flows.ts:551,565`). The only difference between
the two flows is how much conversation already exists when the turn is sent.
Blocked time goes from **0ms** (empty conversation, both before and after
commits) to **533–785ms** (2,511-row conversation, same two commits). That
isolates the cost cleanly: it is coupled to **existing conversation size**, not
to streaming itself, not to the reply's own markdown complexity, and not to
something that regressed recently — it was already there when the team fixed
three-quarters of it in `8f493a1a` and remains today.

---

## 4. Diagnosis

### 4.1 The team has already found and fixed this exact bug class twice — and documented it

`src/stores/useSessionStore.pure.ts`, the doc-comment on `isSameServerTranscript`
(≈L509-520), states the mechanism in the team's own words:

> "Assigning [a re-fetched but identical transcript] re-renders the whole
> transcript for no visible change: on a page of code-heavy messages that is
> markdown parsing and syntax highlighting redone from scratch, and it
> **measured as ~320 ms of blocked main thread** every time a user clicked back
> to a conversation they had just left."

That guard (also `useSessionStore.ts:114-120` for `fetchFromServer`, `:350-352`
for `refreshFromServer`) fixed the "reopen a conversation" trigger. A second
occurrence was found and fixed for the "streaming tick" trigger:
`src/components/chat/utils/messageIdentity.ts:62-80` documents that
`normalizedToChatMessages` "mints brand-new ChatMessage objects on every store
update," which "defeats `React.memo(MessageComponent)`" and "re-renders the
entire visible list on every delta — the CPU churn that makes scrolling choppy
while an agent is working (and pointlessly re-parses markdown/diffs for
messages that did not change)." `stabilizeMessageIdentities` (same file,
L82-120) was written specifically to patch that: it walks the newly-derived
message list and rewrites it to reuse the previous render's object references
for any message whose *value* (deep-compared via `valuesEqual`, L13-51) is
unchanged, so `React.memo` on `MessageComponent`
(`src/components/chat/view/subcomponents/MessageComponent.tsx:52`) can actually
skip re-rendering messages that didn't change.

**This is why §3's numbers went from 785ms blocked to 533ms** — a real,
32% improvement — **but not to zero.** The mitigation removes the unnecessary
*React re-render and re-paint* of unchanged messages; it does not remove the
*recomputation* those messages had to go through to be recognized as
unchanged.

### 4.2 The recomputation itself is still O(total loaded messages), on every streaming tick

Two full-list passes run every time the session store notifies (which, during
a stream, is every ~100ms — see 4.4):

- `normalizedToChatMessages` (`src/components/chat/hooks/useChatMessages.ts:81-326`)
  rebuilds the **entire** `ChatMessage[]` array from scratch on every call —
  fresh object literals for every message, two full-array passes to build the
  tool-result/tool-use maps (L84-105), a third to do the actual conversion
  (L107-323). It is invoked inside a `useMemo` keyed on `storeMessages`
  (`src/components/chat/hooks/useChatSessionState.ts:304-323`), and
  `storeMessages` gets a new array reference on every `notify()` from the
  session store (`src/stores/useSessionStore.ts:401-421`, `updateStreaming`).
- `stabilizeMessageIdentities` (`messageIdentity.ts:82-120`), the fix from 4.1,
  itself walks **every** message with a recursive deep-equality comparison
  (`valuesEqual`, L13-51) to decide which ones can keep their old identity.
  This is the correct fix for the *re-render* problem, but it adds its own
  O(n) pass on top of (a).

Neither pass is bounded by what's actually visible or actually changed; both
run over however many messages are currently loaded for the session, every
~100ms, for as long as a reply streams. This is architecturally the right
shape to reproduce §3's signature exactly: negligible in an empty/short
conversation, and proportionally worse the more history is loaded. (What this
assessment could **not** pin down without a CPU flame graph is the precise
split of the remaining 428-533ms between this mechanism and any other
per-tick or per-fetch cost specific to a large session; §5's phase 0 addresses
that.)

### 4.3 No DOM virtualization for the transcript

`ChatMessagesPane` (`src/components/chat/view/subcomponents/ChatMessagesPane.tsx:260-305`)
`.map()`s every item in `groupedVisibleMessages` into a fully-mounted,
fully-rendered `MessageComponent` — no `react-window`/`react-virtuoso`/
`react-virtualized` dependency exists in `package.json` or anywhere in `src/`
(checked directly). The one bound in place is a coarse pagination window,
`INITIAL_VISIBLE_MESSAGES = 100` (`useChatSessionState.ts:28`), which slices
the *tail* of the array (`useChatSessionState.ts:878-881`) — good for bounding
the common case, but "Load all" (used for in-conversation search, and
available to the user directly) sets `visibleMessageCount` to `Infinity`
(`useChatSessionState.ts:791,796`), after which every one of a 2,500+-row
conversation is a live DOM subtree with its own React state, markdown AST, and
(for code-heavy messages) syntax highlighter output.

Two more full-list recomputations are downstream of this and share the same
"new array reference every tick" problem: `groupConsecutiveTools`
(`ChatMessagesPane.tsx:117-120`, implementation in
`src/components/chat/utils/toolGrouping.ts`) and the key-assignment pass
(`ChatMessagesPane.tsx:132-149`) both re-run on every tick because their
`useMemo` dependency (`visibleMessages` / `groupedVisibleMessages`) is a new
array each time, even when `stabilizeMessageIdentities` successfully reused
every individual message's identity. These are cheaper than 4.2's deep-equality
walk (simple field comparisons, not recursive), but they are additional
per-tick, per-total-message-count work stacked on the same cost center.

### 4.4 Streaming transport is already reasonably engineered — not the smoking gun

Contrary to the "per-token setState" hypothesis this assessment set out to
check: the client already coalesces WebSocket `stream_delta` frames into a
single store update per **100ms window**
(`src/components/chat/hooks/useChatRealtimeHandlers.ts:377-401`, a leading-edge
`window.setTimeout(..., 100)`), not one React update per token. This caps
updates at 10Hz regardless of token rate. The server sends one WS frame per SDK
delta with no server-side batching (`server/modules/providers/list/claude/
claude-sessions.provider.ts:437`, `server/claude-sdk.js:914`), but that only
affects frame count/network overhead, not render cost, since the client-side
throttle is what gates state updates.

This is a real, working mitigation — just not sufficient on its own, because
(per 4.2) what runs inside *each* of those throttled ticks still scales with
total conversation size. Narrowing the interval would not help (more ticks of
the same O(n) work is worse, not better); the fix has to be in what happens
per tick, not how often it fires.

### 4.5 Auto-scroll is already well-engineered — not the bug the user described

The "auto-scroll fights the user" hypothesis does not hold up against the
code: `src/components/chat/utils/autoFollow.ts` is a pure, unit-tested module
that distinguishes deliberate touch-drag intent (`UPWARD_INTENT_PX`,
`shouldSuspendAutoFollow`, L89-97) from programmatic scroll, re-arms only when
pinned within 4px of the bottom (`PINNED_TO_BOTTOM_PX`, `shouldResumeAutoFollow`,
L105-107), and is explicitly documented as the fix for issue #333 ("a jump,
maybe when message is finished streaming"). Streaming growth is tracked
continuously via a `ResizeObserver` on the transcript's content box
(`useChatSessionState.ts:936-958`), not just on new-message boundaries, and
every follow decision is gated by the same "is a finger on the glass right
now" check. This is good engineering already in place; it is not where the
choppiness comes from.

### 4.6 Test coverage is inverted relative to risk

`scripts/check-coverage-floor.mjs` enforces per-suite LINE coverage floors:
**server 80%** (L51), **unit (hooks/pure logic) 85%** (L56), **component (React
rendering) 3%** (L64) — with a header comment recording real coverage at time
of writing as server ~82.7%, unit ~87.8%, **component ~4.3%** (L12-14). The
pure-logic layer implicated in §4.2-4.3 (`messageTransforms`, `messageIdentity`,
`toolGrouping`, `autoFollow`) is in fact heavily unit-tested — dozens of
`.test.ts`/`.spec.tsx` files exist for exactly these modules
(58 test/spec files under `src/components/chat/` alone, out of 142 files). What
is essentially untested is the **React rendering layer itself** — whether
`MessageComponent` actually skips re-rendering when it should, whether a given
change to `ChatMessagesPane` reintroduces a full-list recompute. That is
precisely the layer this assessment is recommending changes to, which raises
the regression risk of any fix here above what the floor numbers alone would
suggest, and argues for adding rendering-behavior tests (render-count
assertions, not just pure-function unit tests) alongside any fix.

### 4.7 Bundle size is real but not obviously chat-relevant

The entry JS chunk is 801KB raw / 236KB gzip (`dist/assets/index-*.js`, current
`HEAD` build). `vendor-codemirror` (693KB/242KB gzip), `vendor-xterm`
(400KB/101KB gzip), and the Mermaid runtime (654KB/158KB gzip) are large but
are separately-chunked and lazy — `Markdown.tsx:9` lazy-loads the Prism
highlighter specifically because it "kept Prism in the entry chunk" before
(#268 in its own comment), and `scripts/check-entry-chunk.mjs` is a dedicated
CI gate (self-tested) that fails the build if Prism grammars, KaTeX, or
Mermaid leak into the entry chunk or its `modulepreload`s again. This is
already a well-guarded area; 236KB gzip for the entry chunk of a multi-surface
app (chat + terminal + editor + git panel + settings, all in one shell) is not
exceptional, and this assessment found no evidence it contributes to the
streaming-choppiness complaint specifically (that's a runtime cost, not a
load-time one). Flagged for completeness, not as a priority.

---

## 5. Options and recommendation

**"Is TypeScript/JavaScript the cause?" — No.** ChatGPT's, Gemini's, and this
app's web front ends are all React SPAs streaming tokens over a
socket/SSE and rendering markdown incrementally. The language and framework
are not what differs. What differs, per §4, is that this codebase currently
re-derives and deep-compares its **entire loaded transcript** on every
streaming tick, and virtualizes nothing, while (based on public knowledge of
how these products behave at scale — not independently re-verified here for
this document) comparable production chat UIs keep per-tick and per-render
work bounded to the turn in progress and the messages actually on screen.

### Option A — Targeted fixes in the current stack

| # | Fix | File(s) | Impact | Effort |
| --- | --- | --- | --- | --- |
| A0 | Capture a CPU profile (`context.tracing` or CDP `Profiler`) of `chat_turn_in_large_conversation`'s `first_token_to_complete` step to confirm the exact split of the 428-533ms blocked time between §4.2's two passes and any other contributor. | new, `bench/` | Enables confident prioritization of A1-A3 | XS (hours) |
| A1 | Make `normalizedToChatMessages` incremental: memoize the conversion per source `NormalizedMessage` (id-keyed cache) so only messages whose underlying row actually changed get reconverted, instead of rebuilding the whole array every tick. | `src/components/chat/hooks/useChatMessages.ts` | Removes the dominant O(n) per-tick cost identified in §4.2; expected to bring `chat_turn_in_large_conversation` blocked-ms toward the `chat_turn` (empty) baseline | M — touches a function with real cross-cutting correctness rules (multi-file-patch tool grouping, pagination-boundary tool-result attachment, subagent containers) that must be preserved incrementally, not just fast |
| A2 | Once A1 returns stable identities for unchanged messages, shrink `stabilizeMessageIdentities`'s job to a cheap no-op check (`===`) instead of a full recursive `valuesEqual` walk. | `src/components/chat/utils/messageIdentity.ts` | Removes the second O(n) pass in §4.2 | S, once A1 lands |
| A3 | Virtualize the transcript (windowing library or a hand-rolled variable-height virtualizer) so off-screen messages are unmounted, particularly for "Load all" sessions. | `src/components/chat/view/subcomponents/ChatMessagesPane.tsx` | Bounds §4.3's DOM/layout cost as conversations grow past hundreds of rows | M-L — interacts with existing scroll-restore math (`scrollRestore.ts`) and pagination, which currently assume real DOM heights |
| A4 | Bound the streaming message's markdown re-parse cost for very long single replies (e.g., render the settled prefix as static HTML/plain text and only re-parse the growing tail), instead of re-parsing the full accumulated string every tick. | `src/components/chat/view/subcomponents/Markdown.tsx` | Prevents the *reply's own* growth from becoming quadratic, independent of §4.2 | L — correctness-sensitive (mid-fence code blocks, tables); the file already has a working pattern to borrow from in `createMermaidFenceGate`/`isFenceComplete` |
| A5 | Add rendering-behavior tests (render-count / re-render assertions) for `MessageComponent` and `ChatMessagesPane` before/alongside A1-A3, given §4.6's coverage gap. | `src/components/chat/**` | Lowers regression risk on the exact area being changed | S-M |

None of A1-A4 qualified as "small and obviously safe enough to ship without
its own review" within this assessment's scope — A1 and A3 are the ones with
real payoff, and both touch code with non-obvious correctness invariants
(documented in the source itself) that deserve a dedicated PR and review, not
a drive-by change bundled into a docs assessment. **No fix from this list was
implemented as part of this task**; A0 is the recommended immediate next step
precisely because it is cheap and de-risks the more invasive A1/A3 work.

### Option B — Front-end rewrite

What it would cost: rebuilding the entire `src/` tree (604 TS/TSX files),
including the terminal (xterm), code editor (CodeMirror), git panel, settings,
PWA, voice, and bug-reporter surfaces that share this shell — not just the
chat view. What it would lose: the 242 commits of hardening ahead of upstream
(a meaningful share of which is exactly the chat/streaming/scroll bug-fix work
cited throughout §4), the ability to keep merging `siteboon/claudecodeui`
upstream at all, the existing Playwright e2e suite (13 spec files) and the
`bench/` harness this assessment relied on, and the unit/server test suites
sitting at 85-88% coverage. It would not, by itself, fix anything in §4 — a
rewritten transcript component would need to solve the exact same problems
(incremental derivation, virtualization, incremental markdown) to avoid
reproducing the same symptom. **Not recommended**: the cost is large, upstream
sync is permanently forfeited, and the problem is not "the whole front end,"
it's the transcript-rendering path specifically.

### Option C — Replace only the chat transcript component

Keep the app shell, WebSocket transport, session store, and every other
surface; rewrite `ChatMessagesPane`/`MessageComponent`/`Markdown` as a new
component with virtualization and incremental derivation designed in from the
start, behind the same props contract. This gets much of Option B's
architectural cleanliness (no O(n) legacy passes to unwind) without touching
the editor/terminal/git/settings/voice/bug-report surfaces or losing upstream
sync ability for the rest of the app. Cost is still real — it has to
re-implement every correctness rule `normalizedToChatMessages`,
`stabilizeMessageIdentities`, `autoFollow`, and `scrollRestore` currently
encode (each with its own issue-number history), or it will re-introduce bugs
those modules were written to fix. **Only worth it if Option A's targeted
fixes (A1-A3) prove insufficient after being tried** — there is no evidence
yet that they would be.

### Recommendation

**Option A, phased**, starting with A0. This is a diagnosis of a specific,
bounded, already-partially-fixed problem in otherwise reasonably-engineered
code (§4.4, §4.5 found the streaming transport and auto-scroll to already be
well-built), not evidence of a systemic architecture failure that justifies a
rewrite (Option B) or even a component replacement (Option C) as a first move.

**Phased plan:**

- **Phase 0 (days):** A0 — CPU profile of the exact blocked-time split.
  Re-run `npm run bench -- --only chat_turn_in_large_conversation --compare`
  on a quiet host to get a clean baseline free of the load-average noise in
  §3's HEAD run.
- **Phase 1 (1-2 weeks):** A1 + A2 together (A2 depends on A1). Measure with
  the same bench flow before/after; target is closing most of the gap between
  `chat_turn` (0-124ms blocked) and `chat_turn_in_large_conversation`
  (428-785ms blocked).
- **Phase 2 (1-2 weeks):** A5 (rendering-behavior tests) alongside or
  immediately after Phase 1, given §4.6.
- **Phase 3 (2-4 weeks, only if Phase 1 doesn't fully close the gap):** A3
  (virtualization). Larger and riskier because of scroll-restore interactions;
  do it once A1/A2 have shown how much of the problem they actually solve.
- **Phase 4 (as needed):** A4, if very long single replies in large
  conversations remain visibly janky after Phase 1-3.

Re-evaluate Option C only if Phase 1-3 are implemented and the measured
blocked-time in `chat_turn_in_large_conversation` still does not approach the
`chat_turn` baseline.
