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

# 2. Install dependencies (if using the REST/proxy tools)
npm install

# 3. Link globally (Optional, allows running from anywhere)
npm link

# 4. Make sure you have Claude installed.
```


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

## Mission Control web dashboard (preview)

A web-based "Mission Control" dashboard is being built alongside the
gateway in [`web/`](./web/). It is a Next.js + TypeScript + TailwindCSS
application that will provide a graphical front end for login, task
management, an embedded terminal/Monaco workspace, and agent
orchestration. The current state is an initial scaffold — see
[`web/README.md`](./web/README.md) for setup and the roadmap.
