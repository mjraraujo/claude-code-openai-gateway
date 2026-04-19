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
The next planned milestones are:

1. **Authentication** — web login screen wired to the gateway's device-
   code flow, persisting the dummy `sk-ant-…` token used to authorise
   browser sessions against the proxy.
2. **Layout** — left Kanban panel, centre terminal + Monaco workspace,
   right agent/model panel.
3. **Advanced features** — `ruflo` preload, harness controls,
   departments, Full Auto Drive.
