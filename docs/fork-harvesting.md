# Harvesting fixes from sibling forks

Upstream is not a channel for getting fixes. In the six weeks after our
2026-07-15 fork point, [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)
merged **20 commits** while carrying ~80 open PRs and ~200 open issues; we were
226 commits ahead over the same window. PRs sit for months, and most of the open
ones duplicate work this fork already shipped.

The useful traffic is **lateral**. A handful of other people are running this app
as their daily driver on a phone, hitting the same mobile/PWA/chat bugs, and
fixing them in their own forks. That is where to look.

## Finding the live forks

Upstream has ~1900 forks and roughly all of them are untouched mirrors. **Sorting
by stars finds nothing** — the top fork by stars has 7 and was last pushed
months ago. The only signal that works is recent pushes plus real divergence.

```bash
# 1. every fork with its last push, newest first
gh api --paginate "repos/siteboon/claudecodeui/forks?per_page=100" \
  --jq '.[] | [.full_name, .pushed_at] | @tsv' > forks.tsv
awk -F'\t' '$2 >= "<our fork point>"' forks.tsv | sort -t$'\t' -k2,2r

# 2. for each candidate, how far has it actually diverged?
gh api "repos/siteboon/claudecodeui/compare/main...OWNER:BRANCH" \
  --jq '"ahead=\(.ahead_by) behind=\(.behind_by)"'
```

Three traps in that second step:

- **The default branch is not always `main`.** Read it per repo
  (`gh api repos/OWNER/REPO --jq .default_branch`); the most disciplined fork we
  found develops on `dev`.
- **Most recently-pushed forks are PR branches, not forks.** Cross-reference
  `gh pr list --repo siteboon/claudecodeui --json author` and drop the authors —
  their "fork" is one open PR you can read directly.
- **`ahead_by` under ~30 is usually noise** — a PR branch, a Docker tweak, a
  changed README.

## The roster

Last swept **2026-08-25**. Re-run the discovery above rather than trusting this
list; it ages.

| Fork | Branch | Character |
|---|---|---|
| `wltiger/my-cloudcli` | `dev` | Closest to our method — disciplined upstream syncs, a `fork-customizations.md` inventory, an explicit bar for what to send upstream. Best source for iOS PWA keyboard work. |
| `MetalZealot/CLIde` | `main` | The deepest UI/mobile fork. Keeps numbered ADRs in `docs/decisions/` — read those first. |
| `spotonroofing/command-center` | `main` | Heavy UI redesign in numbered phases. Built a server-side queued-messages module with an atomic claim. |
| `ryandagg/claudecodeui` | `main` | Session identity/naming, SQLite FTS5 transcript search, worktree-per-session. |

## What we actually want

This is a **single-user fork** and the acceptance filter follows from that. Most
of what these forks build is not for us.

**In scope** — the chat and model experience, which is the whole product here:

- Chat transcript rendering, streaming, message identity and dedup
- The composer: focus, keyboard avoidance, attachments, slash commands, queueing
- Model and provider selection, effort/thinking controls, token and context budget
- Mobile and iOS PWA viewport, scroll, and touch behaviour
- Session lifecycle: naming, status, resume, recovering a wedged run
- Anything that maps to a filed issue in this repo

**Out of scope by default** — we deliberately removed most of this:

- Multi-tenancy, multiple accounts, per-user quotas, SSO, RBAC
- i18n and locales (stripped in #94)
- Additional providers (#77, #196) and the plugin/marketplace surface (#138)
- Desktop/Electron (#149)
- Agent orchestration, task boards, review queues — a different product

**Borderline, decide deliberately.** A solo user pays the discoverability cost of
every settings toggle, so prefer a fix that needs no setting over a preference
that makes the bug optional. Large refactors are worth less than they look:
rebasing one against our divergence usually costs more than re-deriving the idea.

## Reading a fork without drowning

Climb the ladder and stop at the first rung that lets you reject:

1. **Their docs, if any.** ADRs, `FORK.md`, `fork-customizations.md`, `TODO.md`.
   Highest signal per token by a wide margin — a fork that writes down *why* has
   already done the analysis, and its rejected-alternatives section hands you the
   failed attempts for free.
2. **Commit subjects**, filtered by your symptom vocabulary:
   ```bash
   gh api --paginate "repos/OWNER/REPO/commits?sha=BRANCH&per_page=100" \
     --jq '.[] | "\(.commit.author.date[0:10]) \(.commit.message | split("\n")[0])"' \
     | grep -iE 'mobile|keyboard|scroll|composer|touch|pwa|duplicate|queue|stuck'
   ```
3. **Commit message bodies** — `gh api repos/OWNER/REPO/commits/SHA --jq .commit.message`.
   These forks write real ones; the body is often the entire diagnosis.
4. **File list and line counts** to size the change.
5. **The patch.** Last, and only for something you've already decided you want.

## Before valuing anything: check we haven't already fixed it

This is where the time goes. Most candidates duplicate something this fork
already shipped, occasionally worse — we had queueing, dead-socket liveness
detection, and wake-on-visibility before upstream's open PR proposed adding them.

```bash
grep -rn "<mechanism or symbol>" src/ server/
git log --oneline --grep '#<issue>'
gh issue list --repo Josephkready/cloudcli --state all --search '<symptom>'
```

**Our implementation wins by default.** Only prefer theirs when it names a
*mechanism* ours misses — not when it is shorter, newer, or better commented.
Compare mechanisms, never diffs.

A duplicate is still worth noting, though: independent convergence is evidence
the bug is real and general rather than something local to our deployment.

## Verifying before landing

- **Confirm the precondition exists here.** These fixes are written against
  their tree. Check the rule, meta tag, or config the fix depends on is actually
  in ours — a fix for a bug we cannot have is noise.
- **Port the idea, re-implement in our idiom.** Our modules have diverged far
  enough that patches rarely apply; the value is the diagnosis, not the diff.
- **Mobile and PWA claims cannot be certified by our suites.** Playwright cannot
  enter `display: standalone`, so a green run says nothing about the installed
  PWA. Those need a real device (see the `#354` notes) — and a fix that only
  moves a number in a fake viewport is not evidence.

## Landing it

File an issue first so the fix has the same audit trail as one found in-app,
then the normal flow: `/start-work` → implement with tests → `/make-pr`.

All four forks are AGPL-3.0, the same licence as this fork, so the code is
compatible. Credit the source in the commit body — `Ported from OWNER/REPO@<sha>` —
and keep [`NOTICE`](../NOTICE) accurate. Commitlint caps body lines at 100
characters.

## When to sweep

Quarterly is plenty. Out of cycle, sweep when a mobile or PWA bug has survived
two attempted fixes — that is the signature of a bug whose mechanism is
somewhere you are not looking, and it is exactly the kind someone else has
already written an ADR about.
