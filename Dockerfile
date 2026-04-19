# syntax=docker/dockerfile:1.7
#
# Mission Control container.
#
# Two-stage image:
#   1. `web-builder`  — installs `web/` deps and runs `next build`
#                       with `output: "standalone"` so the final
#                       image carries only the compiled server.
#   2. final          — Node 20 runtime serving both the Next.js app
#                       (port 3000) and the gateway proxy (port 18923)
#                       via a tiny shell entrypoint that forwards
#                       signals to both children.

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

# `wget` is used by HEALTHCHECK; busybox wget is already in alpine, so
# we only need a tiny shell.
RUN apk add --no-cache tini

WORKDIR /app

# Gateway entrypoint (no runtime npm deps — it uses node built-ins).
COPY bin/ ./bin/
COPY package.json ./

# Next.js standalone output bundles its own minimal node_modules.
COPY --from=web-builder /app/web/.next/standalone ./web/
COPY --from=web-builder /app/web/.next/static ./web/.next/static
COPY --from=web-builder /app/web/public ./web/public

# Entrypoint script: starts the gateway in the background, then the
# Next.js server in the foreground. Either child exiting kills the
# container so Docker / k8s can restart it cleanly.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /root/.codex-gateway

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    MISSION_CONTROL_GATEWAY_URL=http://127.0.0.1:18923/v1/chat/completions

EXPOSE 3000 18923

# Use tini as PID 1 so signals propagate cleanly to both children.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]

# Health-check the dashboard. /api/auth/status responds quickly and
# returns 200 even when not yet logged in (it just reports state).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/auth/status >/dev/null || exit 1

