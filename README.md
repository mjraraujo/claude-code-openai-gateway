# Claude Code -> OpenAI Gateway 🌉

Use the official [Claude Code CLI](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) powered by your existing **ChatGPT Plus / Pro** subscription.

This project is a local translation proxy. It "hijacks" the official Anthropic CLI's network traffic, translating its requests on the fly into OpenAI's payload format, and routes them to the ChatGPT backend. 

**Zero modifications to the official CLI required.**

## Why use this?
* **Save Money**: Stop paying per-token Anthropic API fees if you already have a ChatGPT subscription.
* **Seamless**: Works with the unmodified, official `@anthropic-ai/claude-code` npm package.
* **Auto-Translation**: Handles the complex mapping between Anthropic's tool-calling format and OpenAI's format in real-time streams (SSE).

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/mjraraujo/claude-code-openai-gateway.git

# 2. (Optional) Link the gateway CLI globally
npm link

# 3. Make sure you have Claude installed.
```

> The gateway CLI (`bin/gateway.js`) has **no runtime npm
> dependencies** — it uses Node built-ins only. The `web/` dashboard
> has its own dependency tree managed in `web/package.json`.


## Quick Start

If you ran `npm link`, you can just type:
```bash
claude-codex
```

Otherwise, run it directly via npm:
```bash
npm run gateway
# or
node bin/gateway.js
```

*(The script will guide you through the OpenAI browser login, and then automatically launch Claude Code!)*

## Disclaimer
Note: This relies on internal OpenAI API endpoints (`/backend-api/codex/responses`). Ensure you comply with OpenAI's Terms of Service. Changes to Anthropic's CLI or OpenAI's API schema may break this gateway.

## Mission Control web dashboard

A web-based "Mission Control" dashboard ships in [`web/`](./web/) — a
Next.js 16 + TypeScript + Tailwind v4 app providing login, task
management, embedded terminal + Monaco workspace, agent orchestration,
side-by-side model comparison, and a re-authentication flow that
doesn't kick you out of the dashboard.

Run it directly:

```bash
cd web && npm install && npm run dev
# dashboard on http://localhost:3000, gateway proxy on :18923
```

Or run both together in Docker (multi-stage image, single container,
process supervisor, healthcheck on `/api/auth/status`):

```bash
docker compose up --build
# 3000 → dashboard, 18923 → gateway proxy
```

Legacy `server.js` and `setup.js` have been moved to
[`legacy/`](./legacy/) — see that folder's README.
