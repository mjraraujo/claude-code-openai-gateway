# Claude Codex 🌉

> **Claude Codex** is a local gateway that lets the official [Claude Code CLI](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) (and a bundled web dashboard) run on your existing **ChatGPT Plus / Pro** subscription instead of paying per-token Anthropic API fees.

The gateway is an Anthropic-shaped HTTP proxy on `127.0.0.1:18923`. A small wrapper (`claude-codex`) exports `ANTHROPIC_BASE_URL=http://127.0.0.1:18923` and `ANTHROPIC_API_KEY=sk-…` (a dummy key the gateway recognises) and then `exec`s the unmodified `claude` binary — so the official CLI runs end-to-end through your ChatGPT session, no source-level patches required.

> **Zero modifications to the official Claude Code CLI required.**

> ⚠️ **Disclaimer.** This relies on internal OpenAI endpoints (`/backend-api/codex/responses`). Make sure you comply with OpenAI's Terms of Service. Changes to either Anthropic's CLI or OpenAI's API may break the gateway.

---

## Table of contents

1. [What you get](#what-you-get)
2. [Repository layout](#repository-layout)
3. [Prerequisites](#prerequisites)
4. [Option A — Use the CLI gateway only (local dev)](#option-a--use-the-cli-gateway-only-local-dev)
5. [Option B — Run the Claude Codex dashboard locally](#option-b--run-the-claude-codex-dashboard-locally)
6. [Option C — Run everything in Docker (one container)](#option-c--run-everything-in-docker-one-container)
7. [Option D — Deploy to a VPS](#option-d--deploy-to-a-vps)
8. [Configuration reference](#configuration-reference)
9. [Persistence, backup & re-login](#persistence-backup--re-login)
10. [Updating](#updating)
11. [Troubleshooting](#troubleshooting)

---

## What you get

* **`bin/gateway.js`** — a zero-dependency Node script that handles the OpenAI device-code login, caches the OAuth token at `~/.codex-gateway/token.json`, and exposes an Anthropic-compatible proxy on **port 18923** that talks to the ChatGPT backend. Linked into `$PATH` as **`claude-codex`** (the wrapper that runs the official `claude` CLI through the proxy with a dummy `ANTHROPIC_API_KEY`) *and* **`claude-codex-gateway`** (the same binary, intended for headless `--serve` mode).
* **`web/`** — Claude Codex dashboard: a Next.js 16 + TypeScript + Tailwind v4 dashboard that wraps the gateway with login, task management, an embedded Monaco workspace + terminal, agent orchestration, side-by-side model comparison, and a re-auth flow that doesn't kick you out.
* **`Dockerfile` + `docker-compose.yml`** — one container that runs both the dashboard (port 3000, the only published port) and the gateway (port 18923, container-internal only) under [`tini`](https://github.com/krallin/tini) with a supervisor entrypoint and a healthcheck on `/api/auth/status`. The Docker image preinstalls `@anthropic-ai/claude-code` so the bundled `claude-codex` wrapper has a `claude` to exec into out of the box.
* **GitHub Actions** that publish the container image to **`ghcr.io/mjraraujo/claude-code-openai-gateway`** on every push to `main` and on every `v*.*.*` tag, and a small docs site to GitHub Pages.

### Why use this?

* **Save money** — stop paying per-token Anthropic API fees if you already have a ChatGPT subscription.
* **Seamless** — works with the unmodified, official `@anthropic-ai/claude-code` npm package.
* **Auto-translation** — handles the complex mapping between Anthropic's tool-calling format and OpenAI's format in real-time SSE streams.

## Repository layout

```
.
├── bin/gateway.js          # CLI + headless proxy (no npm runtime deps)
├── web/                    # Claude Codex dashboard (Next.js 16)
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

# Make sure the official Claude Code CLI is on your PATH.
npm i -g @anthropic-ai/claude-code

# Expose the `claude-codex` and `claude-codex-gateway` commands globally.
npm link

# Start: launches the OpenAI browser login the first time, caches the
# token at ~/.codex-gateway/token.json, then automatically execs into
# the real `claude` CLI with ANTHROPIC_BASE_URL pointed at the proxy.
claude-codex

# Or, if you want only the headless proxy on :18923 (no Claude TUI):
claude-codex-gateway --serve
```

The gateway runs on **`http://127.0.0.1:18923`** and the OAuth token is cached at `~/.codex-gateway/token.json` (mode `0600`). Useful flags:

| Flag | Purpose |
| --- | --- |
| `--login` | Force a fresh device-code login |
| `--setup` | Reconfigure target API URL / default model |
| `--serve` | Headless: run the proxy only (used inside Docker) |

## Option B — Run the Claude Codex dashboard locally

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
docker compose logs -f claude-codex

# Open the dashboard
open http://localhost:3000     # macOS
xdg-open http://localhost:3000 # Linux
```

Then click **Sign in** on the dashboard, complete the OpenAI device-code flow in your browser, and you're done — the token is persisted in the `claude-codex-state` named volume.

### What the compose file actually does

* **Ports** — only the dashboard (`127.0.0.1:3000` by default) is published. The gateway proxy on port `18923` is **container-internal**: it binds to `127.0.0.1` inside the container and is reached by the dashboard over container loopback. There is no host port for `18923`, so it cannot be exposed by accident. If you want to use the gateway from your *host's* Claude Code CLI, run `claude-codex-gateway --serve` directly on the host instead of routing through Docker.
* **Volumes**
  * `claude-codex-state` (named) → `/home/claude/.codex-gateway` — OAuth token + dashboard state. Survives `down` / image rebuilds.
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

1. **The gateway proxy is unauthenticated, so the compose file does not publish port 18923 at all.** It binds to `127.0.0.1` inside the container and is reached by the dashboard over container loopback. Do not add a `18923:18923` port mapping.
2. **Always front port 3000 with HTTPS.** The dashboard holds an OAuth token that must not be served over plain HTTP across the public internet.

### Step-by-step

```bash
# 1. SSH to your VPS and install Docker (one-time)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && newgrp docker

# 2. Get the compose file (no need to clone the whole repo if you use
#    the GHCR image — just grab docker-compose.yml).
mkdir -p /opt/claude-codex && cd /opt/claude-codex
curl -fsSLO https://raw.githubusercontent.com/mjraraujo/claude-code-openai-gateway/main/docker-compose.yml

# 3. Switch to the GHCR image (recommended — no source/Node toolchain needed):
#    Edit docker-compose.yml: comment `build: .` and add
#      image: ghcr.io/mjraraujo/claude-code-openai-gateway:latest

# 4. Bring it up
docker compose up -d
docker compose ps
docker compose logs -f --tail=100
```

> **`http://<vps-ip>:3000` shows nothing?** That's expected — the compose file binds port `3000` to `127.0.0.1` so a fresh `docker compose up` does not silently expose an unauthenticated UI to the public internet. Set up the reverse proxy below (recommended) **or** see [Test over plain HTTP without a domain](#test-over-plain-http-without-a-domain) for a one-line override.

### Reverse proxy + automatic TLS (Caddy)

The smallest possible setup. Install Caddy on the host, then `/etc/caddy/Caddyfile`:

```caddy
codex.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

Caddy will automatically obtain and renew a Let's Encrypt certificate. Visit `https://codex.example.com`, sign in with your ChatGPT account via the device-code flow, and you're done.

### Test over plain HTTP without a domain

If you don't have a domain pointed at the VPS yet and just want to see the dashboard load in a browser, publish port `3000` on the public interface for the duration of the test:

```bash
DASHBOARD_BIND=0.0.0.0 docker compose up -d
# then open http://<vps-ip>:3000
```

Claude Codex auto-detects that the request arrived over plain HTTP and drops the `Secure` flag from the session cookie automatically, so login works without any further configuration. (When you later put it behind Caddy/Nginx, the same code sees `x-forwarded-proto: https` and re-enables `Secure`.)

> **Use this for testing only.** Over plain HTTP the session cookie travels in clear text, and the dashboard has no built-in user accounts — anyone who can reach `<vps-ip>:3000` can drive your ChatGPT session. As soon as you have a domain, switch back to the Caddy flow above (drop the `DASHBOARD_BIND` override and restart).

> Port `18923` (the Anthropic↔OpenAI proxy) is **never** published from the container, regardless of `DASHBOARD_BIND` — it lives entirely inside the container and is reached only over container loopback by the dashboard.

> If your reverse proxy strips `x-forwarded-proto`, force the cookie security mode explicitly with `CLAUDE_CODEX_FORCE_SECURE_COOKIES=1` (always `Secure`) or `CLAUDE_CODEX_INSECURE_COOKIES=1` (never `Secure`). The legacy `MISSION_CONTROL_*` names still work as aliases.

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

        # Claude Codex uses Server-Sent Events for live state.
        proxy_buffering    off;
        proxy_read_timeout 1h;
    }
}
```

### Hostinger VPS quickstart

Hostinger sells generic KVM Linux VPS plans (KVM 1/2/4/8). Claude Codex runs comfortably on **KVM 2** (2 vCPU, 8 GB RAM, 100 GB NVMe) — KVM 1 (1 vCPU, 4 GB) also works but the `next build` inside the image is faster on KVM 2+. There is **no Hostinger-specific Docker image** — you use the same `docker-compose.yml` and GHCR image as any other VPS.

1. **Provision the VPS in hPanel.**
   * *VPS → Create new VPS* → choose **Ubuntu 24.04 with Docker** from the OS templates (this skips step 3). If you pick plain Ubuntu/AlmaLinux, install Docker yourself in step 3.
   * Set a strong root password and add your SSH public key (*VPS → SSH Keys*).
   * Pick a data centre near your users.

2. **Open the firewall.**
   In hPanel → *VPS → Firewall*, create (or attach) a rule set that allows inbound **22/tcp**, **80/tcp**, **443/tcp** only. Do **not** open `3000` — it must stay on loopback. Port `18923` is never published from the container, so there is nothing to block. Hostinger's default firewall blocks everything else, which is what you want.

3. **SSH in and install Docker** (skip if you used the *Ubuntu 24.04 with Docker* template):

   ```bash
   ssh root@<your-vps-ip>
   curl -fsSL https://get.docker.com | sh
   systemctl enable --now docker
   ```

4. **Drop in the compose file and start the container** using the prebuilt GHCR image (no source checkout, no Node toolchain on the VPS):

   ```bash
   mkdir -p /opt/claude-codex && cd /opt/claude-codex
   curl -fsSLO https://raw.githubusercontent.com/mjraraujo/claude-code-openai-gateway/main/docker-compose.yml

   # Replace `build: .` with the GHCR image:
   sed -i 's|^\s*build: \.|    image: ghcr.io/mjraraujo/claude-code-openai-gateway:latest|' docker-compose.yml

   docker compose up -d
   docker compose logs -f --tail=100
   ```

5. **Point a domain at the VPS.**
   * If you bought the domain from Hostinger: *Domains → Manage → DNS / Nameservers → DNS Zone* → add an `A` record for `mission` (or `@`) pointing at the VPS's public IPv4. (Hostinger's `srv*.hstgr.cloud` reverse-DNS hostname works for testing but **Caddy/Let's Encrypt cannot issue a cert for it** — use a real domain you control.)
   * External registrar: create the same `A` record there.

6. **Front it with Caddy for automatic TLS** (run on the VPS, not in the container):

   ```bash
   apt install -y caddy            # Ubuntu 24.04
   cat >/etc/caddy/Caddyfile <<'EOF'
   mission.example.com {
       encode gzip
       reverse_proxy 127.0.0.1:3000
   }
   EOF
   systemctl reload caddy
   ```

   Open `https://codex.example.com`, sign in via the OpenAI device-code flow, and you're done. The OAuth token is persisted in the `claude-codex-state` Docker volume, so container restarts do not log you out.

> **About the Fly.io path.** `fly.toml` in this repo is provided as an alternative deploy target, but `flyctl deploy` only works after the app exists in your Fly org (`fly apps create <name> --org <slug>` or `fly launch --copy-config --no-deploy`). If you hit `Error: app not found`, either create the app first or use this Docker-on-VPS path instead — it has no such prerequisite.

### Hardening checklist

* [ ] Firewall: only `22`, `80`, `443` open. **Do not** open `3000` (port `18923` isn't published from the container, so you can't open it by accident).
* [ ] Run Caddy/Nginx with HTTP→HTTPS redirect.
* [ ] Add HTTP basic auth at the reverse proxy (the dashboard itself has no built-in user accounts — anyone who can reach it can issue commands using your ChatGPT session).
* [ ] Back up the `claude-codex-state` volume (see below).
* [ ] Enable Docker's `--restart unless-stopped` (already set in compose) and `docker system prune` on a schedule.

## Configuration reference

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `CLAUDE_CODEX_GATEWAY_URL` (alias `MISSION_CONTROL_GATEWAY_URL`) | container env (set in `Dockerfile`) | `http://127.0.0.1:18923/v1/messages` | URL the dashboard uses to reach the gateway. The gateway accepts any POST path (Anthropic Messages SSE shape). |
| `CLAUDE_CODEX_WORKSPACE` (alias `MISSION_CONTROL_WORKSPACE`) | container env (set in compose) | `/workspace` | Root of the **default** workspace. The dashboard's fs/exec/chat-tool calls anchor here unless the operator switches to a different workspace via the top-bar selector. |
| `CLAUDE_CODEX_WORKSPACES_DIR` | container env | `/workspace` | Parent directory the dashboard creates fresh workspaces under when the operator clicks "+ new workspace" without supplying an explicit `root`. |
| `NODE_ENV` | container env | `production` | Standard Node env |
| `PORT` | container env | `3000` | Next.js port |
| `HOSTNAME` | container env | `0.0.0.0` | Next.js bind address (inside container) |
| `CLAUDE_CODEX_INSECURE_COOKIES` (alias `MISSION_CONTROL_INSECURE_COOKIES`) | container env (opt-in) | unset | Set to `1` to force the session cookie to NOT be `Secure`, even on HTTPS requests. Normally unnecessary — the cookie security flag auto-detects the request scheme (including `x-forwarded-proto` from a reverse proxy). |
| `CLAUDE_CODEX_FORCE_SECURE_COOKIES` (alias `MISSION_CONTROL_FORCE_SECURE_COOKIES`) | container env (opt-in) | unset | Set to `1` to force the session cookie to ALWAYS be `Secure`, even when the request looks like plain HTTP. Useful when a TLS-terminating proxy strips `x-forwarded-proto`. Wins over `CLAUDE_CODEX_INSECURE_COOKIES`. |
| `CLAUDE_CODEX_EXEC_ALLOW` / `CLAUDE_CODEX_EXEC_DENY` / `CLAUDE_CODEX_EXEC_TIMEOUT_MS` (aliases `MISSION_CONTROL_EXEC_*`) | container env (opt-in) | unset | Override the `/api/exec` policy. See `web/src/lib/exec/policy.ts` for shape. |
| `DASHBOARD_BIND` | host shell, read by `docker-compose.yml` | `127.0.0.1` | Host interface the dashboard's port `3000` is published on. Set to `0.0.0.0` to expose it on the public network — pair with TLS in front, or use it for a temporary plain-HTTP test (the cookie security flag adapts automatically). |

The gateway also reads its own config files from `~/.codex-gateway/`:

* `token.json` — OAuth refresh + access token
* `config.json` — `target_api_url`, `default_model`
* `claude-codex.json` — Claude Codex runtime state (legacy `mission-control.json` is auto-migrated on first boot)

## Workspaces, methodology scaffolding & `agents/*.md`

Each workspace is a directory on disk with a registered id. The
dashboard always operates against one **active workspace**; switch
between them from the workspace selector in the top status bar, or
create a new one with the "+ new workspace" button (the directory
is created under `CLAUDE_CODEX_WORKSPACES_DIR`).

When you switch the **methodology** or **dev-mode** in the harness
panel, the dashboard seeds an opinionated set of starter files into
the active workspace. The seeding is idempotent — existing files
are never overwritten. Currently registered methodologies:

| id | seeds |
| --- | --- |
| `spec-driven` | `SPEC.md`, `DECISIONS.md` |
| `bdd` | `features/example.feature`, `features/README.md` |
| `tdd` | `tests/README.md` |
| `xp` | `PRACTICES.md` |

### `agents/*.md` format

Each workspace can contain an `agents/` directory of one Markdown
file per agent. The dashboard reads these on demand, and the Three
Amigos refinement uses them as the per-persona system prompt.

A file looks like:

```markdown
---
name: Dev
role: developer
model: gpt-5.3-codex
skill: implementation
tools: [read_file, write_file, exec]
---

# Dev

You are the Dev voice in the Three Amigos refinement. Push for
implementation feasibility…
```

Frontmatter keys:

* `name` — display name (defaults to the file's basename)
* `role` — free-form role label
* `model` — overrides the global model for this agent
* `skill` — short description of the agent's specialty
* `tools` — flow-style list (`[a, b]`) or CSV (`a, b`) of tool ids
  this agent is allowed to invoke

The body (everything after the closing `---`) becomes the agent's
system prompt verbatim. The first time a workspace is activated,
the bundled defaults (Dev / QA / PO — the "Three Amigos" trio)
are seeded automatically.

## Persistence, backup & re-login

Everything stateful lives in the `claude-codex-state` named volume. Compose prefixes the volume with the project name (the directory name, by default), so the easiest way to back it up without hard-coding that prefix is to let Compose mount it for you:

```bash
# One-shot backup — writes claude-codex-state-YYYY-MM-DD.tgz into $PWD
docker compose run --rm --no-deps \
  -v "$PWD":/backup \
  --entrypoint sh claude-codex \
  -c 'cd /home/claude/.codex-gateway && tar czf /backup/claude-codex-state-$(date +%F).tgz .'

# Restore (stop the service first so nothing is writing to the volume)
docker compose stop claude-codex
docker compose run --rm --no-deps \
  -v "$PWD":/backup \
  --entrypoint sh claude-codex \
  -c 'cd /home/claude/.codex-gateway && tar xzf /backup/claude-codex-state-YYYY-MM-DD.tgz'
docker compose start claude-codex

# Force re-login (delete the cached token)
docker compose exec claude-codex rm -f /home/claude/.codex-gateway/token.json
docker compose restart claude-codex
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
| Browser cannot reach `http://<vps-ip>:3000` at all (timeout / refused) | The default compose binds port 3000 to `127.0.0.1`. Either set up the Caddy reverse proxy above (recommended) or, for a quick test, bring the stack up with `DASHBOARD_BIND=0.0.0.0 docker compose up -d`. The session cookie will auto-adapt to plain HTTP. See [Test over plain HTTP without a domain](#test-over-plain-http-without-a-domain). |
| Login button "does nothing" / page reloads to `/login` | The session cookie was rejected by the browser. Behind a reverse proxy, make sure it forwards `X-Forwarded-Proto` (Caddy does this automatically; the Nginx snippet above sets it explicitly). If your proxy strips that header, force the cookie mode with `CLAUDE_CODEX_FORCE_SECURE_COOKIES=1` (HTTPS) or `CLAUDE_CODEX_INSECURE_COOKIES=1` (plain HTTP). |
| Dashboard shows "not authenticated" forever | OAuth token expired or never set. Click **Sign in** and complete the device-code flow; check `docker compose logs claude-codex` for `device_code_failed`. |
| In-app terminal shows `Error: listen EADDRINUSE 127.0.0.1:18923` | You ran `node bin/gateway.js` (or `claude-codex-gateway --serve`) from inside the dashboard's terminal. The container's entrypoint already runs the gateway on `:18923`, so a second instance can't bind. Don't re-launch it — just use the `claude-codex` wrapper, or call the gateway directly at `http://127.0.0.1:18923/v1/messages` with an Anthropic-shaped JSON body. |
| `EADDRINUSE: 18923` inside the container at startup | A previous gateway process didn't shut down cleanly. `docker compose restart claude-codex` will clear it. The port is no longer published to the host, so a host-side gateway will not conflict. |
| "Full Auto Drive doesn't do anything" / engages and immediately stops | If you're not signed in, the planner falls back to a tiny mock that completes after two steps — sign in via the dashboard. If you *are* signed in and runs still wedge, click **Force stop / clear** under the Auto-drive section to scrub a stuck singleton, then re-engage. |
| Can reach `:3000` but not via your domain | Reverse proxy missing or DNS not pointing at the VPS. Check `dig codex.example.com` and `caddy validate`. |
| SSE / live updates stop after ~60 s on Nginx | Add `proxy_read_timeout 1h` and `proxy_buffering off` (shown above). |
| Container restart loops | `docker compose logs claude-codex` — usually a missing volume mount or port already in use. |
| "permission denied" on `./workspace` | Fixed automatically: the container's entrypoint now starts as root, `chown`s `/workspace` to the in-container `claude` user, then drops privileges before launching anything. If you still see this on a pre-existing host repo with files owned by another user, `sudo chown -R 10001:10001 ./workspace` once on the host. |

---

Legacy `server.js` and `setup.js` have been moved to [`legacy/`](./legacy/) — see that folder's README.

