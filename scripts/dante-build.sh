#!/usr/bin/env bash
#
# Fail-closed production build for the dante host deploy (see the `cloudcli` service
# entry in Josephkready/dante-config `ansible/host_vars/localhost.yml`).
#
# Why this script exists rather than a plain `npm ci && npm run build`:
#
#   dante-sync (ansible-pull) resets ~/prod/cloudcli to origin/main, runs this as
#   `build_command` when the SHA moves, then restarts cloudcli.service. The restart is
#   gated on that same "SHA moved" condition — NOT on this script's exit code, because
#   the generic build task carries `failed_when: false`. A failed build therefore still
#   gets a restart. Keeping a broken tree off disk is this script's job, not ansible's.
#
#   Both build steps are destructive up front: `vite build` empties dist/, and the
#   `prebuild:server` npm pre-script rm -rf's dist-server/. Building in place would
#   404 the live service's client assets for the whole build AND leave a half-built tree
#   behind on failure — precisely the state a restart would then serve.
#
# So: build into a staging dir, verify the artifacts, and only then swap them in. Any
# failure before the swap leaves the previous good build untouched, making the restart a
# harmless no-op; a failure during the swap restores the previous build from $BACKUP.
#
# This replaces the atomicity the Docker build used to provide for free (a failed
# `docker build` simply left the previous image running). One gap remains that this
# script cannot close on its own — see the npm ci note below.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Staging holds the in-progress build. BACKUP holds the previous good build during the
# swap and MUST live outside STAGE: the EXIT trap wipes STAGE, so a backup kept inside it
# would be destroyed by the very failure it exists to recover from.
STAGE="$ROOT/.dante-build"
BACKUP="$ROOT/.dante-build-prev"
LOCK="$ROOT/.dante-build.lock"

log() { printf '[dante-build] %s\n' "$*"; }
die() { printf '[dante-build] ERROR: %s\n' "$*" >&2; exit 1; }

# Serialize. ansible-pull reconciles on a 1-minute timer and a hand-run build could
# overlap a scheduled one; two runs sharing $STAGE would race on rm -rf/mkdir and could
# interleave their swaps.
exec 9>"$LOCK"
if ! flock -n 9; then
  die "another dante-build is already running (lock: ${LOCK#"$ROOT"/})"
fi

# Only STAGE is disposable on every exit path. BACKUP is deliberately NOT removed here:
# if we die mid-swap it holds the last good build, and swap_in restores from it.
trap 'rm -rf "$STAGE"' EXIT

# A non-empty BACKUP means a previous run died mid-swap without completing its rollback
# (see the CRITICAL path in swap_in) or was hard-killed. Its contents may be the only
# copy of the last good build, and a live tree may be missing right now — so refuse
# rather than delete it. Failing every reconcile until a human looks is the safe answer;
# silently wiping the recovery point is not.
if [ -d "$BACKUP" ] && [ -n "$(find "$BACKUP" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  die "a previous run left builds in ${BACKUP#"$ROOT"/} — it may hold the only copy of the last good build. Restore or remove it by hand, then re-run."
fi

rm -rf "$STAGE" "$BACKUP"
mkdir -p "$STAGE"

# VITE_AUTH_DISABLED is a Vite build-time constant inlined into the client bundle
# (src/constants/config.ts), so it has to be set HERE. The systemd unit's runtime copy
# governs the server only and cannot affect dist/. Defaults to on for the dante deploy
# (single user, private network); export VITE_AUTH_DISABLED=false to build with login
# restored.
export VITE_AUTH_DISABLED="${VITE_AUTH_DISABLED:-true}"

log "installing dependencies (npm ci)"
# devDependencies are required: vite, typescript and tsc-alias all live there.
#
# ACCEPTED RESIDUAL RISK: unlike the build steps below, this mutates the LIVE tree —
# npm ci deletes and repopulates node_modules in place, and it cannot be staged because
# it must run beside package.json. If it is interrupted (network, OOM, a systemd
# timeout), node_modules can be left partial even though dist/ and dist-server/ still
# hold the good build, and the unconditional restart that follows could then fail to
# boot. Staging the whole tree to close this would cost a full duplicate install per
# deploy. The real fix belongs on the ansible side — gate the restart on this script's
# exit code instead of on "git SHA moved" — and is handled in the dante-config change.
npm ci --no-audit --no-fund

log "building client -> staging (VITE_AUTH_DISABLED=${VITE_AUTH_DISABLED})"
npx vite build --outDir "$STAGE/dist" --emptyOutDir

log "building server -> staging"
# Invoked directly rather than via `npm run build:server` because that script's
# `prebuild:server` hook hard-codes rm -rf of the LIVE dist-server/, which is exactly
# what staging exists to avoid. tsc and tsc-alias both accept an absolute --outDir
# (tsc-alias documents it as tsconfig-relative, but absolute works and is verified by
# the alias check below).
npx tsc -p server/tsconfig.json --outDir "$STAGE/dist-server"
npx tsc-alias -p server/tsconfig.json --outDir "$STAGE/dist-server"

# --- Verification gate -------------------------------------------------------------
# The steps above duplicate what package.json's build scripts do. If that wiring ever
# changes underneath this script, these checks fail the build instead of letting an
# empty or malformed tree get swapped in and served.

# One artifact per emitted tree: the client bundle's entry, the server entry systemd
# actually execs, and one file from each of the two source roots tsc emits (server/ and
# the repo-level shared/, which land side by side under dist-server/).
for artifact in \
  "$STAGE/dist/index.html" \
  "$STAGE/dist-server/server/index.js" \
  "$STAGE/dist-server/server/shared/utils.js" \
  "$STAGE/dist-server/shared/networkHosts.js"
do
  [ -s "$artifact" ] || die "expected build artifact missing or empty: ${artifact#"$ROOT"/}"
done

# tsc emits the `@/...` path aliases verbatim; node cannot resolve them at runtime, so
# a skipped tsc-alias yields a server that dies on its first aliased import. Catch it
# here rather than at restart.
#
# Both quote styles must be matched: tsc preserves the source file's original quotes in
# its output, and the tree genuinely contains both (server/shared/utils.ts uses single,
# server/modules/database/init-db.ts uses double). Matching only one style would let a
# real unrewritten import slip through the gate that exists to catch it.
if grep -rqE --include='*.js' "(from|import\()[[:space:]]*['\"]@/" "$STAGE/dist-server" 2>/dev/null; then
  die "unresolved @/ alias imports in staged server build — tsc-alias did not rewrite output"
fi

# --- Swap --------------------------------------------------------------------------
# Same-filesystem renames, so the window where a live path is absent is sub-millisecond.
#
# The previous build is moved into $BACKUP rather than deleted, and restored if the
# incoming move fails. Getting this wrong is worse than a stale build: a live tree that
# was moved aside but never replaced leaves the path MISSING, and the restart that
# follows is not gated on our exit code, so it would serve nothing at all.

# Moves the previous tree aside into $BACKUP, then the staged tree into place. Returns
# non-zero (rather than dying) so the caller can roll back BOTH trees together.
swap_in() {
  local staged="$1" live="$2"
  local prev
  prev="$BACKUP/$(basename "$live")"

  mkdir -p "$BACKUP"
  rm -rf "$prev"

  if [ -e "$live" ]; then
    mv "$live" "$prev" || die "failed to back up ${live#"$ROOT"/} before swapping"
  fi
  mv "$staged" "$live" || return 1
}

# Restores every tree that still has a backup, newest failure first. The two trees must
# stay paired: a new client bundle served against old server code is its own kind of
# broken, so a failure on the second swap rolls the first one back too. $BACKUP still
# holds every tree swapped so far because it is not cleaned until both have succeeded.
rollback_all() {
  local name
  local restored=0

  for name in dist dist-server; do
    if [ -e "$BACKUP/$name" ]; then
      rm -rf "${ROOT:?}/$name"
      mv "$BACKUP/$name" "$ROOT/$name" \
        || die "CRITICAL: $name is MISSING and its backup in ${BACKUP#"$ROOT"/} could not be restored — restore it by hand before the service restarts"
      log "rolled back $name to the previous build"
      restored=1
    fi
  done

  if [ "$restored" -eq 0 ]; then
    log "nothing to roll back (no previous build was on disk)"
  fi
  return 0
}

log "swapping staged build into place"
if ! swap_in "$STAGE/dist" "$ROOT/dist"; then
  rollback_all
  die "failed to swap the staged client build into dist"
fi
if ! swap_in "$STAGE/dist-server" "$ROOT/dist-server"; then
  rollback_all
  die "failed to swap the staged server build into dist-server"
fi

# Both trees are live and paired; the backups have no further use. Reached only on
# success — any earlier failure leaves recovery to rollback_all, or to the operator via
# the CRITICAL message and the startup guard.
rm -rf "$BACKUP"

log "build complete"
