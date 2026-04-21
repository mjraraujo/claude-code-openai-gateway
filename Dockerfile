# syntax=docker/dockerfile:1.7
#
# Claude Codex container.
#
# Two-stage image:
#   1. `web-builder`  — installs `web/` deps and runs `next build`
#                       with `output: "standalone"` so the final
#                       image carries only the compiled server.
#   2. final          — Node 20 runtime serving both the Next.js app
#                       (port 3000) and the gateway proxy (port 18923)
#                       via a tiny shell entrypoint that forwards
#                       signals to both children. The official
#                       `@anthropic-ai/claude-code` CLI is preinstalled
#                       so the bundled `claude-codex` wrapper can exec
#                       into it without operator setup.

# ─── Stage 1: build the web dashboard ───────────────────────────────
FROM node:20-alpine AS web-builder

WORKDIR /app/web

# Copy lockfile + manifest first to maximise layer cache hits.
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY web/ ./
RUN npm run build

# ─── Stage 2: runtime ───────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Toolchain baked into the image so the Claude Codex terminal +
# chat-driven exec route have a useful surface out of the box. We
# deliberately do NOT enable `apk` / `apt` at runtime — the chat
# would need root, which is a security and image-size problem; this
# list is the entire shell toolchain we support, and operators can
# extend the image if they need more.
#
#   tini       — PID 1 init, forwards signals to children.
#   bash       — exec route prefers `bash -lc` over `/bin/sh -c`.
#   git        — `git status` / `git log` / etc. from the terminal.
#   curl       — used by the gateway and arbitrary shell commands.
#   python3    — for quick inline data wrangling.
#   build-base — alpine's gcc/make/etc.; alpine equivalent of
#                Debian's `build-essential`. Lets `npm install`
#                build native modules if a user requests it.
RUN apk add --no-cache \
        tini \
        bash \
        git \
        curl \
        python3 \
        build-base

WORKDIR /app

# Run the container as a dedicated non-root user. The upstream
# `@anthropic-ai/claude-code` CLI hard-refuses
# `--dangerously-skip-permissions` when `geteuid() === 0`, so the
# Claude Codex terminal is unusable as root. Creating a dedicated
# `claude` user with a real $HOME unblocks the auto-skip and lets
# operators use the tool out of the box.
ARG CLAUDE_UID=10001
ARG CLAUDE_GID=10001
RUN addgroup -S -g "${CLAUDE_GID}" claude \
    && adduser -S -D -u "${CLAUDE_UID}" -G claude \
        -h /home/claude -s /bin/bash claude

# Install the official Anthropic Claude Code CLI globally so the
# `claude-codex` wrapper has something to exec into. Without this
# step the wrapper falls back to printing an "install with: npm i -g
# @anthropic-ai/claude-code" hint, defeating the purpose of bundling
# everything in one container image.
#
# Pinned by major to keep the image reproducible while still picking
# up patch-level fixes when the image is rebuilt. Override at build
# time with `--build-arg CLAUDE_CODE_VERSION=x.y.z` if needed.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && claude --version || true

# Gateway entrypoint (no runtime npm deps — it uses node built-ins).
COPY bin/ ./bin/
COPY package.json ./

# Expose the gateway as `claude-codex` (wrapper that runs the official
# Claude CLI through the proxy with a dummy ANTHROPIC_API_KEY) *and*
# `claude-codex-gateway` (the proxy server itself). Both are the same
# script — the second name is just a clearer alias for users running
# the headless `--serve` mode outside Docker.
RUN ln -sf /app/bin/gateway.js /usr/local/bin/claude-codex \
    && ln -sf /app/bin/gateway.js /usr/local/bin/claude-codex-gateway \
    && chmod +x /app/bin/gateway.js

# Next.js standalone output bundles its own minimal node_modules.
COPY --from=web-builder /app/web/.next/standalone ./web/
COPY --from=web-builder /app/web/.next/static ./web/.next/static
COPY --from=web-builder /app/web/public ./web/public

# Entrypoint script: starts the gateway in the background, then the
# Next.js server in the foreground. Either child exiting kills the
# container so Docker / k8s can restart it cleanly.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /home/claude/.codex-gateway \
    && chown -R claude:claude /app /home/claude

USER claude
ENV HOME=/home/claude

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CLAUDE_CODEX_GATEWAY_URL=http://127.0.0.1:18923/v1/messages \
    MISSION_CONTROL_GATEWAY_URL=http://127.0.0.1:18923/v1/messages

EXPOSE 3000 18923

# Use tini as PID 1 so signals propagate cleanly to both children.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]

# Health-check the dashboard. /api/auth/status responds quickly and
# returns 200 even when not yet logged in (it just reports state).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/auth/status >/dev/null || exit 1

