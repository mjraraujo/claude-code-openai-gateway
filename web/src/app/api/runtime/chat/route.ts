/**
 * POST /api/runtime/chat
 *
 * Streaming chat pass-through used by the Mission Control ChatDock.
 *
 * `bin/gateway.js` is an Anthropic-shaped proxy that always streams
 * SSE (`event: message_start / content_block_delta / message_delta /
 * message_stop`). This route forwards the user's conversation to the
 * gateway and pipes its SSE response back to the browser unchanged,
 * adding only auth + basic input validation.
 *
 * Mirrors the model selection used by `/api/runtime/compare` and the
 * Agents panel (sourced from `HarnessState.model`) so the entire
 * Mission Control surface speaks to one backend at a time.
 */

import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getOrCreateSessionApiKey, getValidToken } from "@/lib/auth/storage";
import { isValidModelId } from "@/lib/runtime";
import { getGatewayUrl } from "@/lib/runtime/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TOTAL_CHARS = 32_000;
const MAX_PER_MESSAGE_CHARS = 16_000;
const MAX_SYSTEM_CHARS = 8_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_MESSAGES = 64;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface Body {
  model?: unknown;
  system?: unknown;
  messages?: unknown;
  maxTokens?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!isValidModelId(model)) {
    return NextResponse.json({ error: "invalid_model" }, { status: 400 });
  }

  const system =
    typeof body.system === "string"
      ? body.system.slice(0, MAX_SYSTEM_CHARS)
      : "";

  const messages = parseMessages(body.messages);
  if (messages.length === 0) {
    return NextResponse.json({ error: "no_messages" }, { status: 400 });
  }

  const maxTokens = clampInt(body.maxTokens, 16, 4096, 1024);

  const token = await getValidToken();
  if (!token) {
    return NextResponse.json(
      {
        error: "no_token",
        message: "sign in via Claude Codex to chat",
      },
      { status: 401 },
    );
  }

  const apiKey = await getOrCreateSessionApiKey();

  // Forward to the local gateway. We want to abort the upstream
  // request if either (a) the client disconnects (req.signal) or
  // (b) the request runs longer than REQUEST_TIMEOUT_MS.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  if (req.signal) {
    if (req.signal.aborted) ctrl.abort();
    else req.signal.addEventListener("abort", () => ctrl.abort());
  }

  let upstream: Response;
  try {
    upstream = await fetch(getGatewayUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        ...(system ? { system } : {}),
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: true,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error).name === "AbortError";
    return NextResponse.json(
      { error: aborted ? "timeout" : "gateway_unreachable" },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timer);
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      {
        error: "gateway_error",
        status: upstream.status,
        message: text.slice(0, 400),
      },
      { status: 502 },
    );
  }

  // Pipe the upstream SSE body straight to the client. The timer is
  // cleared when the response body is consumed (or the signal aborts
  // it). Wrap in a TransformStream so we can attach a teardown.
  const ts = new TransformStream<Uint8Array, Uint8Array>({
    flush() {
      clearTimeout(timer);
    },
  });
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer));

  upstream.body.pipeTo(ts.writable).catch(() => {
    // Upstream errors mid-stream are surfaced to the client by the
    // closed stream — no good way to inject an SSE error frame here
    // without buffering the whole stream. The browser-side parser
    // treats an EOF mid-message as end-of-turn.
  });

  return new Response(ts.readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Hint to proxies (e.g. nginx) not to buffer the SSE stream.
      "X-Accel-Buffering": "no",
    },
  });
}

function parseMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  let totalChars = 0;
  for (const item of raw.slice(-MAX_MESSAGES)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const role =
      r.role === "assistant" ? "assistant" : r.role === "user" ? "user" : null;
    if (!role) continue;
    const content =
      typeof r.content === "string"
        ? r.content.slice(0, MAX_PER_MESSAGE_CHARS)
        : "";
    if (!content) continue;
    totalChars += content.length;
    if (totalChars > MAX_TOTAL_CHARS) break;
    out.push({ role, content });
  }
  // The Anthropic Messages API requires the last message to be from
  // the user. If the caller violated that, drop trailing assistant
  // turns so we send a coherent request.
  while (out.length > 0 && out[out.length - 1].role !== "user") {
    out.pop();
  }
  return out;
}

function clampInt(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}
