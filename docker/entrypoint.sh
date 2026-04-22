#!/bin/sh
# Container entrypoint: start the gateway proxy in the background, then
# launch the Next.js standalone server in the foreground. If either
# child dies, kill the other so the container exits and the orchestrator
# (Docker / Compose / k8s) can restart it cleanly.

set -e

# ── Privilege drop ────────────────────────────────────────────────
# We start as root *only* so we can fix the ownership of bind-mounted
# volumes before handing control to the unprivileged `claude` user
# (uid 10001) that the rest of the stack expects.
#
# Why this is needed:
#   * Docker bind mounts (e.g. `./workspace:/workspace` from
#     docker-compose.yml) inherit ownership from the host
#     filesystem, which silently overrides the `chown -R claude:claude
#     /workspace` baked into the image. A fresh `./workspace`
#     auto-created by `docker compose up` is owned by root, so the
#     in-container `claude` user gets EACCES on every write — visible
#     to operators as "permission denied" on `npm install`, file
#     creation from the dashboard, `claude-codex` writes, etc.
#   * The named state volume (`/home/claude/.codex-gateway`) is also
#     created by Docker as root on first run.
#
# Strategy:
#   * `chown` `/workspace` non-recursively so we hand the directory
#     itself to `claude` (enabling new-file creation) without
#     rewriting the ownership of any pre-existing host content the
#     operator mounted in.
#   * `chown -R` `/home/claude/.codex-gateway` because that volume is
#     entirely ours to manage.
#   * Re-exec this script under `su-exec claude:claude` so the rest
#     runs unprivileged, preserving signal handling under tini.
if [ "$(id -u)" = "0" ]; then
    chown claude:claude /workspace 2>/dev/null || true
    chown -R claude:claude /home/claude/.codex-gateway 2>/dev/null || true
    exec su-exec claude:claude "$0" "$@"
fi

# Start the gateway proxy on port 18923. It only needs Node built-ins,
# so no extra `npm install` runs at container start.
node /app/bin/gateway.js --serve &
GATEWAY_PID=$!

# Forward SIGTERM / SIGINT to both children for graceful shutdown.
term() {
    kill -TERM "$GATEWAY_PID" 2>/dev/null || true
    kill -TERM "$NEXT_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" 2>/dev/null || true
    wait "$NEXT_PID" 2>/dev/null || true
    exit 0
}
trap term TERM INT

# Watchdog: if the gateway exits unexpectedly, take the container down
# so it can be restarted.
(
    wait "$GATEWAY_PID"
    echo "[entrypoint] gateway exited; shutting down container" >&2
    kill -TERM "$NEXT_PID" 2>/dev/null || true
) &

# Next.js standalone server expects to be invoked from its own dir.
cd /app/web
node server.js &
NEXT_PID=$!

wait "$NEXT_PID"
