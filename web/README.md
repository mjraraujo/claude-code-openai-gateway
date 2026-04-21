# Mission Control — Web Frontend

This directory contains the **Mission Control** web dashboard for the
[`claude-code-openai-gateway`](../README.md) proxy. It is a Next.js (App
Router) + TypeScript + TailwindCSS application that will become the
graphical front end for the local Anthropic-to-OpenAI translation
gateway.

> **Status:** Initial scaffold only. Authentication wiring, the Kanban
> task board, the embedded terminal/Monaco workspace, and the agent
> orchestration panel land in subsequent iterations.

## Prerequisites

- Node.js 20+ (Next.js 16 minimum)
- npm 9+
- The gateway running locally — see the [root README](../README.md). The
  dashboard expects the proxy at `http://localhost:18923` (the port used
  by `bin/gateway.js`).

## Getting started

```bash
# from the repository root
cd web
npm install     # only needed the first time
npm run dev     # starts Next.js on http://localhost:3000
```

In a second terminal, start the gateway as usual:

```bash
# from the repository root
npm run gateway
```

Open <http://localhost:3000> in your browser. The placeholder landing
page confirms the scaffold is wired up correctly.

## Available scripts

| Script          | Description                                      |
| --------------- | ------------------------------------------------ |
| `npm run dev`   | Start the Next.js dev server (Turbopack).        |
| `npm run build` | Production build.                                |
| `npm run start` | Run the production build.                        |

## Project layout

```
web/
├── src/
│   └── app/
│       ├── globals.css   # Tailwind entry
│       ├── layout.tsx    # Root layout + metadata
│       └── page.tsx      # Landing page (placeholder)
├── public/               # Static assets
├── next.config.ts
├── postcss.config.mjs
├── tsconfig.json
└── package.json
```

## Roadmap

The full Mission Control specification lives in the project description.
Progress so far:

- [x] **Step 2 — Scaffold** — Next.js 16 (App Router) + TypeScript + Tailwind v4
- [x] **Step 3 — Authentication** — `/login` page wired to OpenAI's
      device-code flow via `POST /api/auth/login/{start,poll}`. Tokens
      land in `~/.codex-gateway/token.json` (shared with the CLI
      gateway). HttpOnly cookie session backed by a persisted dummy
      `sk-ant-…` key in `~/.codex-gateway/session-key.json`. A Next.js
      Proxy (`src/proxy.ts`, formerly Middleware) gates every page
      behind that cookie.
- [x] **Step 4 — Mission Control layout shells** — three-panel grid
      under a top status bar. Left: Kanban + sprint/methodology/dev-mode
      toggles. Centre: tabbed workspace (Terminal / Workspace /
      Side-by-Side). Right: agent orchestration, model selector,
      harness toggles, departments, and a Full Auto Drive engagement
      button with a confirmation modal.
- [x] **Step 5 — Real interactivity**
  - Workspace tab now renders **Monaco Editor** (dynamic-imported,
    SSR-disabled) backed by `GET/PUT /api/fs/file` and a directory
    tree from `GET /api/fs/tree`. Save with the button or ⌘S; dirty
    state and conflict-free overwrite.
  - Terminal tab is a real **streaming shell**: client posts to
    `POST /api/exec`, server runs `bash -lc <cmd>` in the gateway
    repo and streams stdout/stderr/exit as Server-Sent Events.
    Supports ↑↓ history, ⌘C to cancel a running command, ⌘K to
    clear, output truncation (4 MB), 5-minute hard timeout, and a
    blocklist for the obvious destructive prefixes.
- [x] **Step 6 — Agent runtime**
  - **In-process orchestrator** with persistent state at
    `~/.codex-gateway/mission-control.json` (atomic write-rename).
    Single `EventEmitter`-backed store fans out updates to every SSE
    subscriber.
  - **Bounded tool surface** in `src/lib/runtime/tools.ts`:
    `read_file` / `write_file` / `exec`. Every call routes through
    `safeJoin` + `assertInsideWorkspace` and the same exec blocklist
    as `/api/exec`. Per-call read cap 64 KB, write cap 256 KB, exec
    output cap 64 KB, exec wall-time cap 30 s.
  - **Planner** (`planner.ts`) calls the local Codex gateway when a
    valid OAuth token is present (`POST /v1/chat/completions` with
    `response_format: json_object`), and falls back to a deterministic
    mock planner when not — so the loop is observable in dev/test
    without burning credits.
  - **Auto-drive loop** (`drive.ts`) is fire-and-forget: API returns
    immediately, loop continues until any of step-cap (1–50, default
    12), wall-time (5–1800 s, default 300 s), byte budget (1 KB–8 MB,
    default 1 MB), explicit `/auto-drive` stop, planner `done`, or
    error. Exactly one run at a time; hard 409 on overlap.
  - **Departments + cron**: minute-resolution scheduler started on
    first import, schedule grammar `every Nm`, `every Nh`, `@hourly`,
    `@daily`. Per-job step cap 1–6, 90 s wall-time, overlap-protected
    via an in-flight set so a slow job never stacks up.
  - **API** all session-cookie gated:
    `GET /api/runtime/state` (SSE),
    `PATCH /api/runtime/harness`,
    `POST /api/runtime/auto-drive` (`{action:"start"|"stop", goal?, …}`),
    `POST|DELETE /api/runtime/departments`,
    `POST|DELETE /api/runtime/departments/[id]/cron`.
  - **Right rail** rewired to live state: agent rows light up while a
    run is active; harness toggles persist server-side; engage opens a
    confirm modal with goal + step budget; live run log modal streams
    the planner/tool/result transcript; department modal manages cron
    jobs in place.
- [x] **Step 7 — Polish**
  - **Kanban persistence**: tasks are stored in
    `mission-control.json` alongside the rest of the runtime state
    and pushed to every tab via SSE. `POST|PATCH|DELETE
    /api/runtime/tasks` for create / move / delete. Seed cards
    (T-101 → T-106) land in "Shipped" reflecting their real status.
  - **Kanban → Auto Drive bridge**: each non-shipped card has a
    "▶ run" action that moves it to the active sprint, starts an
    auto-drive run with the card title as the goal (8-step cap),
    and records the run id on the card. A pulsing "running" badge
    appears while the run is live. An inline "+ New" form lets you
    create cards with a title, target column, and optional tag.
  - **Status bar runtime indicator**: while auto-drive is active the
    top bar shows a pulsing red dot + live step count. While idle it
    shows the total cron count.
- [x] **Step 8 — Phone / responsive shell**
  - Single Next.js app auto-adapts: at `>=lg` (1024 px) the unchanged
    3-column desktop grid renders; below that, a single-pane
    `MobileShell` with a bottom tab bar (Tasks · Workspace · Agents)
    reuses the *same* `KanbanPanel` / `WorkspaceCenter` / `AgentsPanel`
    components so the SSE state, auth, and `/api/runtime/*` surface
    are identical on both shells. Selection is reactive via
    `useBreakpoint` (Tailwind `lg` cutoff, `matchMedia`-based).
  - Installable PWA: `app/manifest.ts` plus `viewport` /
    `theme-color` / `apple-mobile-web-app-*` metadata in
    `app/layout.tsx`. No service worker — the dashboard is online-only
    (live SSE), so a stale offline shell would cause more harm than
    good.
  - All four modals (`AutoDriveConfirm`, `RunLogModal`,
    `DepartmentModal`, `ReauthModal`) go full-screen below `sm:` and
    pad with `env(safe-area-inset-bottom)` so iPhone home-indicator
    devices don't clip the close button.

## Using Mission Control on a phone

Mission Control is a single responsive web app — there is no separate
mobile build to deploy. On phones and small tablets (`<1024 px`) it
switches to a single-pane shell with a bottom tab bar (**Tasks ·
Workspace · Agents**); on desktops it keeps the three-column grid. The
underlying SSE state, session, and `/api/runtime/*` surface are shared.

**Add to home screen.**

- *iOS Safari:* tap the share icon → **Add to Home Screen**. Launches
  full-screen with no browser chrome.
- *Android Chrome:* tap the ⋮ menu → **Install app** / **Add to Home
  screen**.

The PWA manifest at `/manifest.webmanifest` is generated by
`src/app/manifest.ts`. There is intentionally **no service worker** —
the whole dashboard is built around live SSE from the gateway, so a
cached offline shell would just show stale state.

**Auth on phone is the same session cookie as desktop.** Sign in via
`/login` once on the phone (the same OpenAI device-code flow), and the
session cookie covers every API call afterwards.

**Network exposure.** If you want to reach Mission Control from your
phone over the LAN, you need *one* of:

1. **HTTPS** in front of the dashboard (recommended for anything beyond
   `localhost`). The session cookie is set `Secure` in production —
   plain `http://` over the LAN will silently drop it.
2. `MISSION_CONTROL_INSECURE_COOKIES=1` on the server (testing-only
   opt-out, see `web/src/lib/auth/session.ts`). Only do this on a
   trusted network — the cookie travels in cleartext.

The gateway itself stays on `127.0.0.1:18923` and is not what your
phone talks to; your phone talks to Next.js on `:3000`, which proxies
to the gateway.

## Filesystem & exec safety

All `/api/fs/*` and `/api/exec` routes require the session cookie.
Paths are resolved through `safeJoin()` (`src/lib/fs/workspace.ts`)
which:

1. Refuses absolute inputs and traversal segments.
2. Re-checks containment after `path.resolve`.
3. `realpath`s the result so symlinks pointing outside the workspace
   are rejected.

`MISSION_CONTROL_WORKSPACE` overrides the workspace root if you don't
want the parent of `web/`. `MISSION_CONTROL_GATEWAY_URL` overrides the
default chat-completions endpoint (`http://127.0.0.1:18923/v1/chat/completions`)
for containerised or remote deployments.

## Architecture notes

- **Auth state is shared with the CLI.** The web app reads and writes
  the same `~/.codex-gateway/token.json` file as `bin/gateway.js`, so
  signing in via either surface authorises the other.
- **Edge-safe proxy.** `src/proxy.ts` only checks for cookie presence;
  the full constant-time comparison against the on-disk key happens in
  Node-runtime API routes (`src/lib/auth/session.ts`). Forged cookies
  cannot reach authenticated endpoints.
- **No real LLM calls from the browser.** The dashboard talks to its
  own Next.js API routes (server-side), which talk to OpenAI / the
  local proxy. The dummy `sk-ant-…` key is the same value Claude Code
  presents to the gateway, keeping a single credential across surfaces.
