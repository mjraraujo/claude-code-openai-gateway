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
- [ ] **Step 5 — Real interactivity** — wire `@monaco-editor/react` for
      the Workspace tab and a WebSocket-backed PTY (e.g. `xterm.js` +
      `node-pty`) for the Terminal tab.
- [ ] `ruflo` preload, harness control plane, Departments & cron
      runners, Full Auto Drive execution loop with guardrails.

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
