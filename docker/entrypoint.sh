#!/bin/sh
# Container entrypoint: start the gateway proxy in the background, then
# launch the Next.js standalone server in the foreground. If either
# child dies, kill the other so the container exits and the orchestrator
# (Docker / Compose / k8s) can restart it cleanly.

set -e

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
