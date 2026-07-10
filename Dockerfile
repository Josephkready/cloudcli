# syntax=docker/dockerfile:1.7
#
# Dante deploy Dockerfile for CloudCLI (this repo — @cloudcli-ai/cloudcli, a
# fork of siteboon/claudecodeui). Built and run on the `dante` host by
# dante-sync (Josephkready/dante-config, service `cloudcli`, docker_build:
# true). The image lives only on dante — no registry, no `docker login`.
#
# This file used to live in a separate wrapper repo (claudecodeui-docker)
# that `git clone`d this fork inside the build. That indirection forced a
# CACHE_BUST arg + a cron GitHub Action to poll this fork's SHA. Now that the
# Dockerfile lives in-tree, the Docker build context IS the checked-out fork,
# so a new commit naturally invalidates the cache — no CACHE_BUST, no clone,
# no cross-repo poll. Upstream (siteboon) ships no root Dockerfile, so this
# fork-only file never conflicts on upstream sync.

# ── Build stage ──────────────────────────────────────────────────────────────
# Full install + build (vite client + tsc server). The whole devDependency
# tree is required here (vite, tsc, tsc-alias, sharp, etc.) — none of it ships
# in the runtime stage. The source is copied before `npm ci` because the
# `postinstall` (scripts/fix-node-pty.js) and husky `prepare` hooks both need
# the source tree present.
FROM node:22-slim AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY . .
RUN npm ci \
 && npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
# Lean image. Copies ONLY the built artifacts from the builder + runs a fresh
# `npm ci --omit=dev` so the runtime node_modules contains true prod deps
# only — no leaked devDependencies, no build-time tooling, no source tree.
#
# Two further size optimisations on top of that fresh install:
#
# 1. Drop the @anthropic-ai/claude-agent-sdk platform-native binaries
#    (~450MB). The SDK's optionalDependencies ship a bundled `claude`
#    executable per (os, libc) pair. cloudcli explicitly passes
#    `pathToClaudeCodeExecutable: 'claude'` (resolved from PATH) when calling
#    `query()`, so the SDK never executes its own bundled binary. The
#    `@anthropic-ai/claude-code` global install below provides the real
#    `claude` on PATH.
#
# 2. Drop client-only npm packages (~180MB: lucide-react, react, codemirror,
#    xterm, etc.) that the fork's package.json lists as production
#    dependencies but that exist solely to be bundled into `dist/` by Vite at
#    build time. The runtime server never imports them. Audited on
#    2026-05-16: zero references in `server/` or `shared/` under the fork.
#    If a new client-only dep is added upstream it should be appended here.
#
# The @openai/codex-sdk path resolves through node_modules, so the
# @openai/codex-linux-x64 native (~200MB) is intentionally kept.
FROM node:22-slim

# Runtime apt deps only: git is needed because cloudcli shells out to it for
# project clone/star operations; ca-certificates for HTTPS. We do NOT install
# python3 / build-essential here — native modules use prebuilt binaries from
# `prebuild-install` during `npm ci` below, no node-gyp fallback is needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/cloudcli

# Only the build artefacts + manifests + native-build helper script. No src/,
# no server/ source (the compiled output lives in dist-server/), no
# node_modules from the builder stage.
COPY --from=builder --chown=1000:1000 /build/package.json /build/package-lock.json ./
COPY --from=builder --chown=1000:1000 /build/dist ./dist
COPY --from=builder --chown=1000:1000 /build/dist-server ./dist-server
COPY --from=builder --chown=1000:1000 /build/public ./public
COPY --from=builder --chown=1000:1000 /build/scripts ./scripts

# Fresh prod-only install in the runtime stage. We strip the fork's
# `prepare: husky` lifecycle hook first — husky is a devDependency and is
# absent here, so npm would otherwise abort the install with "husky: not
# found". Native modules (better-sqlite3, node-pty, bcrypt) still need their
# own install scripts to run so prebuild-install can drop the platform .node
# binary — so we do NOT pass --ignore-scripts.
RUN node -e "const p=require('./package.json');delete p.scripts.prepare;delete p.scripts.postinstall;require('fs').writeFileSync('package.json',JSON.stringify(p,null,2));" \
 && npm ci --omit=dev --no-audit --no-fund \
 && rm -rf \
      node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 \
      node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl \
      node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64 \
      node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl \
      node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64 \
      node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64 \
      node_modules/@anthropic-ai/claude-agent-sdk-win32-x64 \
      node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64 \
      node_modules/@codemirror \
      node_modules/@replit \
      node_modules/@tailwindcss \
      node_modules/@uiw \
      node_modules/@xterm \
      node_modules/class-variance-authority \
      node_modules/clsx \
      node_modules/cmdk \
      node_modules/fuse.js \
      node_modules/i18next \
      node_modules/i18next-browser-languagedetector \
      node_modules/jszip \
      node_modules/katex \
      node_modules/lucide-react \
      node_modules/node-fetch \
      node_modules/react \
      node_modules/react-dom \
      node_modules/react-dropzone \
      node_modules/react-error-boundary \
      node_modules/react-i18next \
      node_modules/react-markdown \
      node_modules/react-router-dom \
      node_modules/react-syntax-highlighter \
      node_modules/rehype-katex \
      node_modules/rehype-raw \
      node_modules/remark-gfm \
      node_modules/remark-math \
      node_modules/tailwind-merge \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/* /var/tmp/*

# Sibling CLIs that cloudcli auto-discovers and shells out to. The
# corresponding auth state lives in ~/.claude/, ~/.codex/, ~/.gemini/,
# ~/.cursor/ on the host — exposed inside the container by the whole-home
# bind mount + HOME=/home/jkready in the dante-config service entry.
RUN npm install -g --omit=dev --no-audit --no-fund \
      @anthropic-ai/claude-code \
      @openai/codex \
      @google/gemini-cli \
      task-master-ai \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/* /var/tmp/*

# Symlink the cloudcli bin onto PATH.
RUN ln -sf /opt/cloudcli/dist-server/server/cli.js /usr/local/bin/cloudcli \
 && chmod +x /opt/cloudcli/dist-server/server/cli.js

USER 1000:1000
WORKDIR /home/node

EXPOSE 3001

ENTRYPOINT ["cloudcli"]
CMD ["start"]
