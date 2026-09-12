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
long the conversation already is. A CPU profile taken for this assessment
found Prism syntax-highlighting to be the single largest attributable cost in
that window; a small, safe fix for one real cause of it (redundant
re-highlighting of unchanged code blocks) was implemented and measured as part
of this task. A rewrite is not needed to fix the rest; a handful of further
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
- Local `main` is **244 commits ahead** of the merge-base with upstream (real
  feature/bugfix work, including most of the chat-perf hardening cited below)
  and **41 commits behind** `upstream/main` (not the ~20 estimated in the
  project's own todos).
- Local `package.json` version is `1.36.3`; upstream's latest tag is `v1.37.3`.

This matters for the rewrite-vs-fix decision in §4: a rewrite forfeits the
ability to keep merging upstream, and 244 commits is a large amount of
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
| `chat_turn_in_large_conversation` blocked, **before** this assessment's A1 fix (§4.2) | — | — | median **813ms** (n=5, range 365-1009) |
| `chat_turn_in_large_conversation` blocked, **after** A1 (`PrismCodeBlock` memoized) | — | — | median **537ms** (n=5, range 385-737) |

\* HEAD numbers were captured under host load average ≈20/16 cores; treat as
order-of-magnitude corroboration, not a precise regression measurement. The
A1 before/after rows were measured the same way, on the same busy host,
alternating before/after within one window per the bench README's own
guidance for shared-machine measurement — see §4.2 for the full picture,
including that Prism's own self-time did not move as cleanly as the blocked-ms
number suggests.

**The key isolating comparison:** `chat_turn` and `chat_turn_in_large_conversation`
send the **identical** mock reply content (`fillComposer(..., `echo:${ECHOED_REPLY}`)`
in both flow definitions, `bench/flows.ts:550,572`). The only difference between
the two flows is how much conversation already exists when the turn is sent.
Blocked time goes from **0ms** (empty conversation, both before and after
commits) to **533–1009ms** (2,511-row conversation, across all measurements in
this document). That isolates the cost cleanly: it is coupled to **existing
conversation size**, not to a *difference* in the reply's own content (both
flows send the same reply) and not to something that regressed recently — it
was already there when the team fixed three-quarters of it in `8f493a1a` and
remains today. It does *not* rule out the reply's own markdown/code content
being a major absolute contributor to the cost in both flows equally — §4.2
found evidence that it is — only that it cannot explain the *difference*
between the two flows.

---

## 4. Diagnosis

### 4.1 The team has already found and fixed this exact bug class twice — and documented it

`src/stores/useSessionStore.pure.ts`, the doc-comment on `isSameServerTranscript`
(L492-508), states the mechanism in the team's own words:

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

### 4.2 CPU-profile-confirmed: Prism is the largest attributable JS cost — but the mechanism is more specific than "unchanged code re-highlights"

This assessment did not stop at "something scales with conversation size" —
it captured an actual CPU profile of the `chat_turn_in_large_conversation`
step, reusing the bench harness's own server/fixture/flow code with a Chrome
DevTools `Profiler.start()`/`Profiler.stop()` wrapped around the identical
`measure()` call the bench itself runs (script not committed; a one-off
diagnostic, method described here so it is reproducible). One run against the
same 2,511-row fixture reproduced the symptom cleanly —
`first_token_to_complete = 790.8ms, blocked = 509.0ms` — and the resulting
`.cpuprofile` gives a direct answer instead of a plausible guess:

| Self time (of ~2.30s sampled across the whole turn) | Share | Source |
| ---: | ---: | --- |
| 710.8 ms | 31.0% | `(program)` — V8-internal (GC, compile, native) |
| **620.4 ms** | **27.0%** | **`prismLanguages-*.js`** (the syntax-highlighter chunk) |
| 141.4 ms | 6.2% | `(idle)` |
| 96.6 ms | 4.2% | React commit-phase code in the entry chunk |
| 40.8 ms | 1.8% | `(garbage collector)` |

**Prism — the syntax highlighter — is the single largest attributable
JavaScript cost in the step, roughly 6x the next-largest app-code contributor.**
Walking the call stack on the hottest Prism samples confirms *where* it is
invoked from: `PrismCodeBlock`'s highlight call, several frames deep inside a
**React commit** (`vendor-react-*.js` fiber-commit functions call directly into
the `prismLanguages` chunk).

`PrismCodeBlock` (`src/shared/markdown/PrismCodeBlock.tsx:31-49`) renders
`react-syntax-highlighter`'s `SyntaxHighlighter` directly in its function
body — it re-tokenizes and re-highlights its `code` prop **on every render**,
with no memoization of its own, because the underlying library does the
highlighting as part of rendering, not lazily. That is a real, general
inefficiency: any already-rendered code block whose message re-renders for an
unrelated reason (a sibling's identity churn, an ancestor's unstable prop)
pays a full re-tokenize of content that has not changed. This assessment
implemented and shipped the fix for exactly that (`React.memo` around
`PrismCodeBlock`, all three props are primitives so the default shallow
comparator is exactly correct — see the linked PR, with a regression test).

**What the before/after measurement showed, honestly:** wrapping
`PrismCodeBlock` in `memo()` and re-running the identical profiled scenario
(5 runs before, 5 after, alternating on the same shared host) moved the
step's median blocked time from 813ms to 537ms — a real 34% reduction, but
noisy (before ranged 365-1009ms, after 385-737ms; the ranges overlap). Looking
at Prism's own self-time specifically, rather than overall blocked-ms, it did
**not** show a clear drop between the two (median ~506ms before vs. ~610ms
after, well within the run-to-run noise on this host). The reason: the bench's
one echoed reply itself contains a single fenced code block, which is still
*actively streaming in* — growing — for most of the measured window. That
code's `code` prop is genuinely different on every tick, so `memo()` correctly
lets those re-highlights through; it was never going to catch them. Most of
the profiled Prism cost in this particular scenario is that streaming fence
re-highlighting its own growing content, not stale siblings re-highlighting
unchanged content — a distinct, larger problem (§5's option A5: bound the
*streaming* message's own re-parse cost, the same way `mermaidFences.ts`
already gates on fence completeness for diagrams). The 2,511-row conversation
still shows dramatically more blocking than an empty one sending the identical
reply (§3) — general system load from the surrounding large DOM plausibly
inflates the *same* per-tick Prism cost rather than multiplying how often it
runs; this assessment did not fully separate those two effects.

The practical takeaway: the memoization fix is correct, safe, and closes a
real inefficiency (confirmed by a passing regression test asserting the
underlying render function is not re-invoked for unchanged props) — but it is
not, by itself, the fix for the specific number in §3. A5 (streaming-fence
gating) is the more likely lever for that, and was not attempted here because
it is materially riskier (correctness-sensitive around partial fences) and
does not meet this assessment's bar for a same-task, drive-by change.

### 4.3 The surrounding O(n) passes are still real, just not the dominant cost measured here

Two full-list passes still run every time the session store notifies (which,
during a stream, is every ~100ms — see 4.5), and are the most likely reason a
code-block message's props end up looking "changed" often enough for §4.2 to
bite as hard as it does:

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
  O(n) pass on top of (a), and — being a deep comparison — is exactly the kind
  of logic where one field it doesn't expect to see change (or a caller
  passing a message through a code path this pass doesn't cover) would quietly
  reintroduce the churn it exists to prevent.

Neither pass is bounded by what's actually visible or actually changed; both
run over however many messages are currently loaded for the session, every
~100ms, for as long as a reply streams — the right shape to reproduce §3's
scaling signature even setting Prism aside. Confirming exactly how often these
passes fail to reuse a code-block message's identity (vs. some other trigger
for the re-render §4.2 measured) is the natural next diagnostic step, now that
§4.2 has narrowed *what* the re-render is expensive for.

### 4.4 No DOM virtualization for the transcript

> **Update 2026-09-11:** addressed in #489 (`@tanstack/react-virtual`,
> pinned `3.14.12`), landed as phase 2 of this assessment's plan — see that
> PR for the measurements. The dependency-inventory claim below is from this
> doc's original point-in-time assessment and is intentionally left as
> written rather than rewritten after the fact; read it as "true when this
> was measured," not as a currently-accurate statement of `package.json`.

`ChatMessagesPane` (`src/components/chat/view/subcomponents/ChatMessagesPane.tsx:260-305`)
`.map()`s every item in `groupedVisibleMessages` into a fully-mounted,
fully-rendered `MessageComponent` — no `react-window`/`react-virtuoso`/
`react-virtualized` dependency exists in `package.json` or anywhere in `src/`
(checked directly). The one bound in place is a coarse pagination window,
`INITIAL_VISIBLE_MESSAGES = 100` (`useChatSessionState.ts:28`), which slices
the *tail* of the array (`useChatSessionState.ts:878-881`) — good for bounding
the common case, but "Load all" (used for in-conversation search, and
available to the user directly) sets `visibleMessageCount` to `Infinity`
(`useChatSessionState.ts:789,798`), after which every one of a 2,500+-row
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

### 4.5 Streaming transport is already reasonably engineered — not the smoking gun

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

### 4.6 Auto-scroll is already well-engineered — not the bug the user described

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

### 4.7 Test coverage is inverted relative to risk

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

### 4.8 Bundle size is real but not obviously chat-relevant

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
(a) re-highlights unchanged code blocks synchronously during React commits
(§4.2, the single largest measured cost), (b) re-derives and deep-compares its
**entire loaded transcript** on every streaming tick (§4.3), and (c)
virtualizes nothing (§4.4), while (based on public knowledge of how these
products behave at scale — not independently re-verified here for this
document) comparable production chat UIs keep per-tick and per-render work
bounded to the turn in progress and the messages actually on screen.

### Option A — Targeted fixes in the current stack

| # | Fix | File(s) | Impact | Effort |
| --- | --- | --- | --- | --- |
| A1 | Stop `PrismCodeBlock` re-highlighting when its `code`/`language`/`isDarkMode` props haven't changed (`React.memo`, all-primitive props — no custom comparator needed). | `src/shared/markdown/PrismCodeBlock.tsx` | Directly targets §4.2, the largest single measured cost (27% of sampled CPU time in this assessment's profile, ~6x the next-largest app-code contributor) | **XS** — one component, three primitive props, default shallow memo is exactly correct |
| A2 | Make `normalizedToChatMessages` incremental: memoize the conversion per source `NormalizedMessage` (id-keyed cache) so only messages whose underlying row actually changed get reconverted, instead of rebuilding the whole array every tick. | `src/components/chat/hooks/useChatMessages.ts` | Reduces how often *any* message's props look "new" to React — the likely reason §4.2's re-renders happen as often as they do | M — touches a function with real cross-cutting correctness rules (multi-file-patch tool grouping, pagination-boundary tool-result attachment, subagent containers) that must be preserved incrementally, not just fast |
| A3 | Once A2 returns stable identities for unchanged messages, shrink `stabilizeMessageIdentities`'s job to a cheap no-op check (`===`) instead of a full recursive `valuesEqual` walk. | `src/components/chat/utils/messageIdentity.ts` | Removes the second O(n) pass in §4.3 | S, once A2 lands |
| A4 | Virtualize the transcript (windowing library or a hand-rolled variable-height virtualizer) so off-screen messages are unmounted, particularly for "Load all" sessions. | `src/components/chat/view/subcomponents/ChatMessagesPane.tsx` | Bounds §4.4's DOM/layout cost as conversations grow past hundreds of rows | M-L — interacts with existing scroll-restore math (`scrollRestore.ts`) and pagination, which currently assume real DOM heights |
| A5 | Bound the streaming message's markdown re-parse cost for very long single replies (e.g., render the settled prefix as static HTML/plain text and only re-parse the growing tail), instead of re-parsing the full accumulated string every tick. | `src/components/chat/view/subcomponents/Markdown.tsx` | Prevents the *reply's own* growth from becoming quadratic, independent of §4.2-4.3 | L — correctness-sensitive (mid-fence code blocks, tables); the file already has a working pattern to borrow from in `createMermaidFenceGate`/`isFenceComplete` |
| A6 | Add rendering-behavior tests (render-count / re-render assertions, including "a code block does not re-highlight when its message is unchanged") for `MessageComponent`, `PrismCodeBlock`, and `ChatMessagesPane`, alongside A2-A4, given §4.7's coverage gap. | `src/components/chat/**`, `src/shared/markdown/**` | Lowers regression risk on the exact area being changed | S-M |

**A1 was implemented as part of this task**, in a separate PR from this
document (numbers in §3 and §4.2 above; the PR carries the code change and a
regression test). A2-A5 were not: A2 and A4 in particular touch code with
non-obvious correctness invariants (documented in the source itself) that
deserve a dedicated PR and review, not a drive-by change bundled into a docs
assessment.

### Option B — Front-end rewrite

What it would cost: rebuilding the entire `src/` tree (604 TS/TSX files),
including the terminal (xterm), code editor (CodeMirror), git panel, settings,
PWA, voice, and bug-reporter surfaces that share this shell — not just the
chat view. What it would lose: the 244 commits of hardening ahead of upstream
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
fixes (A2-A5) prove insufficient after being tried** — there is no evidence
yet that they would be.

### Recommendation

**Option A, phased.** This is a diagnosis of a specific, bounded,
already-partially-fixed problem in otherwise reasonably-engineered code
(§4.5, §4.6 found the streaming transport and auto-scroll to already be
well-built), not evidence of a systemic architecture failure that justifies a
rewrite (Option B) or even a component replacement (Option C) as a first move.

**Phased plan:**

- **Done, as part of this task:** A1 (memoize `PrismCodeBlock`), landed with a
  regression test and a before/after measurement (§4.2). It closes a real,
  general inefficiency, but — measured honestly — was not the dominant lever
  for the specific `chat_turn_in_large_conversation` number, because most of
  that scenario's Prism cost turned out to be the actively-streaming reply's
  own growing code fence, not stale siblings.
- **Phase 1 (days):** A follow-up CPU profile, this time isolating the
  streaming-fence cost from the surrounding-conversation-size cost (e.g.
  profile a reply with no code fence at all, in both an empty and a large
  conversation) — §4.2's investigation raised this as an open question this
  assessment did not fully resolve. Re-run on a quiet host to get a reading
  free of the load-average noise both this profiling and §3's HEAD run hit.
- **Phase 2 (1-2 weeks):** A2 + A3 together (A3 depends on A2). Measure with
  the bench flow before/after; target is closing more of the remaining gap
  between `chat_turn` (0-124ms blocked) and `chat_turn_in_large_conversation`
  (428-1009ms blocked across the measurements in this document).
- **Phase 3 (1-2 weeks):** A6 (rendering-behavior tests) alongside or
  immediately after Phase 2, given §4.7.
- **Phase 4 (2-4 weeks, only if Phase 1's profile shows conversation-size
  scaling still dominates after Phase 2):** A4 (virtualization). Larger and
  riskier because of scroll-restore interactions; do it once A2/A3 have shown
  how much of the problem they actually solve.
- **Phase 5 (as needed):** A5 (streaming-fence gating for markdown/Prism), if
  Phase 1's profile confirms the streaming reply's own growing content is a
  major independent contributor — plausible given §4.2's finding — rather than
  folding it into whichever phase turns out to need it.

Re-evaluate Option C only if Phase 1-4 are implemented and the measured
blocked-time in `chat_turn_in_large_conversation` still does not approach the
`chat_turn` baseline.
