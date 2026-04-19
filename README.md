# Claude Code → OpenAI Gateway 🌉

Use the official [Claude Code CLI](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), or the bundled **Mission Control** web dashboard, powered by your existing **ChatGPT Plus / Pro** subscription.

This project is a local translation proxy. It "hijacks" the official Anthropic CLI's network traffic, translating its requests on the fly into OpenAI's payload format, and routes them to the ChatGPT backend.

> **Zero modifications to the official Claude Code CLI required.**

> ⚠️ **Disclaimer.** This relies on internal OpenAI endpoints (`/backend-api/codex/responses`). Make sure you comply with OpenAI's Terms of Service. Changes to either Anthropic's CLI or OpenAI's API may break the gateway.

---

## Table of contents

1. [What you get](#what-you-get)
2. [Repository layout](#repository-layout)
3. [Prerequisites](#prerequisites)
4. [Option A — Use the CLI gateway only (local dev)](#option-a--use-the-cli-gateway-only-local-dev)
5. [Option B — Run the Mission Control dashboard locally](#option-b--run-the-mission-control-dashboard-locally)
6. [Option C — Run everything in Docker (one container)](#option-c--run-everything-in-docker-one-container)
7. [Option D — Deploy to a VPS](#option-d--deploy-to-a-vps)
8. [Configuration reference](#configuration-reference)
9. [Persistence, backup & re-login](#persistence-backup--re-login)
10. [Updating](#updating)
11. [Troubleshooting](#troubleshooting)

---

## What you get

* **`bin/gateway.js`** — a zero-dependency Node script that handles the OpenAI device-code login, caches the OAuth token at `~/.codex-gateway/token.json`, and exposes an Anthropic-compatible proxy on **port 18923** that talks to the ChatGPT backend.
* **`web/`** — Mission Control: a Next.js 16 + TypeScript + Tailwind v4 dashboard that wraps the gateway with login, task management, an embedded Monaco workspace + terminal, agent orchestration, side-by-side model comparison, and a re-auth flow that doesn't kick you out.
* **`Dockerfile` + `docker-compose.yml`** — one container that runs both the dashboard (port 3000) and the gateway (port 18923) under [`tini`](https://github.com/krallin/tini) with a supervisor entrypoint and a healthcheck on `/api/auth/status`.
* **GitHub Actions** that publish the container image to **`ghcr.io/mjraraujo/claude-code-openai-gateway`** on every push to `main` and on every `v*.*.*` tag, and a small docs site to GitHub Pages.

### Why use this?

* **Save money** — stop paying per-token Anthropic API fees if you already have a ChatGPT subscription.
* **Seamless** — works with the unmodified, official `@anthropic-ai/claude-code` npm package.
* **Auto-translation** — handles the complex mapping between Anthropic's tool-calling format and OpenAI's format in real-time SSE streams.

## Repository layout

```
.
├── bin/gateway.js          # CLI + headless proxy (no npm runtime deps)
├── web/                    # Mission Control dashboard (Next.js 16)
├── docker/entrypoint.sh    # Supervisor: runs gateway + Next.js under tini
├── Dockerfile              # Multi-stage build (web-builder → runtime)
├── docker-compose.yml      # Single-service compose for local + VPS
├── legacy/                 # Old server.js / setup.js (kept for reference)
└── .github/workflows/      # CI: pages.yml (docs), docker.yml (GHCR)
```

## Prerequisites

You only need the prerequisites for the option you choose.

| Option | Requires |
| --- | --- |
| A — CLI only | Node.js ≥ 18, `@anthropic-ai/claude-code` installed globally (`npm i -g @anthropic-ai/claude-code`), an active ChatGPT Plus/Pro account |
| B — Dashboard locally | Node.js ≥ 20, npm ≥ 10 |
| C — Docker locally | Docker ≥ 24 with the Compose v2 plugin |
| D — VPS deployment | Linux VPS, Docker, a domain name, and a reverse proxy (Caddy, Nginx, or Traefik) |

## Option A — Use the CLI gateway only (local dev)

```bash
git clone https://github.com/mjraraujo/claude-code-openai-gateway.git
cd claude-code-openai-gateway

# Optional: expose the `claude-codex` command globally
npm link

# Start: launches the OpenAI browser login the first time, then
# automatically execs into Claude Code.
claude-codex
# or, without npm link:
node bin/gateway.js
```

The gateway runs on **`http://127.0.0.1:18923`** and the OAuth token is cached at `~/.codex-gateway/token.json` (mode `0600`). Useful flags:

| Flag | Purpose |
| --- | --- |
| `--login` | Force a fresh device-code login |
| `--setup` | Reconfigure target API URL / default model |
| `--serve` | Headless: run the proxy only (used inside Docker) |

## Option B — Run the Mission Control dashboard locally

```bash
cd web
npm install
npm run dev
# dashboard:  http://localhost:3000
# gateway:    http://localhost:18923  (auto-started in dev)
```

Tests: `npm test` (vitest). Production build: `npm run build && npm start`.

## Option C — Run everything in Docker (one container)

The provided `docker-compose.yml` builds the multi-stage image and runs both the gateway proxy and the dashboard in one container, supervised by `tini`.

```bash
git clone https://github.com/mjraraujo/claude-code-openai-gateway.git
cd claude-code-openai-gateway

# First-time build + start
docker compose up -d --build

# Tail logs
docker compose logs -f mission-control

# Open the dashboard
open http://localhost:3000     # macOS
xdg-open http://localhost:3000 # Linux
```

Then click **Sign in** on the dashboard, complete the OpenAI device-code flow in your browser, and you're done — the token is persisted in the `mission-control-state` named volume.

### What the compose file actually does

* **Ports** — `127.0.0.1:3000` (dashboard) and `127.0.0.1:18923` (gateway) are bound to **loopback only**. The dashboard talks to the gateway over container loopback, so the host port for `18923` only matters if you want your *host's* Claude Code CLI to use it. The proxy has **no authentication** — never publish it on `0.0.0.0`.
* **Volumes**
  * `mission-control-state` (named) → `/root/.codex-gateway` — OAuth token + Mission Control state. Survives `down` / image rebuilds.
  * `./workspace` (bind) → `/workspace` — the directory the dashboard's filesystem + exec tools operate on. Auto-created on first `up` if missing.
* **Healthcheck** — `wget` against `/api/auth/status` every 30 s (defined in `Dockerfile`).
* **Restart policy** — `unless-stopped`.

### Use the prebuilt GHCR image instead of building locally

Edit `docker-compose.yml` and replace `build: .` with:

```yaml
    image: ghcr.io/mjraraujo/claude-code-openai-gateway:latest
```

Then:

```bash
docker compose pull
docker compose up -d
```

Available tags: `latest` (default branch), `vX.Y.Z` and `X.Y` (release tags), and short SHAs like `sha-abc1234`.

## Option D — Deploy to a VPS

The compose file is **deploy-ready** with two important caveats:

1. **Never publish port 18923 publicly** — it is an unauthenticated proxy. The default `127.0.0.1:18923:18923` binding handles this for you.
2. **Always front port 3000 with HTTPS.** The dashboard holds an OAuth token that must not be served over plain HTTP across the public internet.

### Step-by-step

```bash
# 1. SSH to your VPS and install Docker (one-time)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && newgrp docker

# 2. Get the compose file (no need to clone the whole repo if you use
#    the GHCR image — just grab docker-compose.yml).
mkdir -p /opt/mission-control && cd /opt/mission-control
curl -fsSLO https://raw.githubusercontent.com/mjraraujo/claude-code-openai-gateway/main/docker-compose.yml

# 3. Switch to the GHCR image (recommended — no source/Node toolchain needed):
#    Edit docker-compose.yml: comment `build: .` and add
#      image: ghcr.io/mjraraujo/claude-code-openai-gateway:latest

# 4. Bring it up
docker compose up -d
docker compose ps
docker compose logs -f --tail=100
```

### Reverse proxy + automatic TLS (Caddy)

The smallest possible setup. Install Caddy on the host, then `/etc/caddy/Caddyfile`:

```caddy
mission.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

Caddy will automatically obtain and renew a Let's Encrypt certificate. Visit `https://mission.example.com`, sign in with your ChatGPT account via the device-code flow, and you're done.

### Equivalent Nginx snippet

```nginx
server {
    listen 443 ssl http2;
    server_name mission.example.com;

    ssl_certificate     /etc/letsencrypt/live/mission.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mission.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Mission Control uses Server-Sent Events for live state.
        proxy_buffering    off;
        proxy_read_timeout 1h;
    }
}
```

### Hardening checklist

* [ ] Firewall: only `22`, `80`, `443` open. **Do not** open `3000` or `18923`.
* [ ] Run Caddy/Nginx with HTTP→HTTPS redirect.
* [ ] Add HTTP basic auth at the reverse proxy (the dashboard itself has no built-in user accounts — anyone who can reach it can issue commands using your ChatGPT session).
* [ ] Back up the `mission-control-state` volume (see below).
* [ ] Enable Docker's `--restart unless-stopped` (already set in compose) and `docker system prune` on a schedule.

## Configuration reference

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `MISSION_CONTROL_GATEWAY_URL` | container env (set in `Dockerfile`) | `http://127.0.0.1:18923/v1/chat/completions` | URL the dashboard uses to reach the gateway |
| `MISSION_CONTROL_WORKSPACE` | container env (set in compose) | `/workspace` | Root the dashboard's fs/exec tools are sandboxed to |
| `NODE_ENV` | container env | `production` | Standard Node env |
| `PORT` | container env | `3000` | Next.js port |
| `HOSTNAME` | container env | `0.0.0.0` | Next.js bind address (inside container) |

The gateway also reads its own config files from `~/.codex-gateway/`:

* `token.json` — OAuth refresh + access token
* `config.json` — `target_api_url`, `default_model`
* `mission-control.json` — Mission Control runtime state

## Persistence, backup & re-login

Everything stateful lives in the `mission-control-state` named volume. Compose prefixes the volume with the project name (the directory name, by default), so the easiest way to back it up without hard-coding that prefix is to let Compose mount it for you:

```bash
# One-shot backup — writes mission-control-state-YYYY-MM-DD.tgz into $PWD
docker compose run --rm --no-deps \
  -v "$PWD":/backup \
  --entrypoint sh mission-control \
  -c 'cd /root/.codex-gateway && tar czf /backup/mission-control-state-$(date +%F).tgz .'

# Restore (stop the service first so nothing is writing to the volume)
docker compose stop mission-control
docker compose run --rm --no-deps \
  -v "$PWD":/backup \
  --entrypoint sh mission-control \
  -c 'cd /root/.codex-gateway && tar xzf /backup/mission-control-state-YYYY-MM-DD.tgz'
docker compose start mission-control

# Force re-login (delete the cached token)
docker compose exec mission-control rm -f /root/.codex-gateway/token.json
docker compose restart mission-control
```

## Updating

```bash
# If you build locally
git pull
docker compose up -d --build

# If you use the GHCR image
docker compose pull
docker compose up -d
```

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `docker compose up` warns about `version` being obsolete | You're on an old copy of `docker-compose.yml`; pull the latest. |
| Dashboard shows "not authenticated" forever | OAuth token expired or never set. Click **Sign in** and complete the device-code flow; check `docker compose logs mission-control` for `device_code_failed`. |
| `EADDRINUSE: 18923` on host | Another gateway is already running locally. Stop it or remove the `127.0.0.1:18923:18923` line from compose. |
| Can reach `:3000` but not via your domain | Reverse proxy missing or DNS not pointing at the VPS. Check `dig mission.example.com` and `caddy validate`. |
| SSE / live updates stop after ~60 s on Nginx | Add `proxy_read_timeout 1h` and `proxy_buffering off` (shown above). |
| Container restart loops | `docker compose logs mission-control` — usually a missing volume mount or port already in use. |
| "permission denied" on `./workspace` | The bind mount is created as root by Docker. Either `sudo chown -R $USER ./workspace` on the host or run compose as root. |

---

Legacy `server.js` and `setup.js` have been moved to [`legacy/`](./legacy/) — see that folder's README.

