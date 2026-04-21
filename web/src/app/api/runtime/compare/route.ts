/**
 * POST /api/runtime/compare
 *
 * Side-by-Side comparison endpoint. Sends the same prompt to up to N
 * model lanes in parallel via the local gateway and returns each
 * response together with latency, token usage, and error info.
 *
 * Each lane is independent: a slow / failed lane never blocks the
 * others. The route waits for all lanes to settle (via
 * `Promise.allSettled`) so the UI can show a single populated grid
 * once everything is in.
 *
 * The route deliberately does *not* stream — the lanes are short
 * one-shot completions, and the dashboard already has a streaming
 * surface (Auto Drive). Side-by-Side optimises for an at-a-glance
 * comparison, not real-time tool use.
 *
 * Wire protocol note: `bin/gateway.js` is an Anthropic-shaped proxy
 * that *always* streams SSE (it has no non-streaming JSON mode). So
 * we send `{ system, messages, max_tokens }` and parse the resulting
 * `event: message_start / content_block_delta / message_delta /
 * message_stop` stream into a single accumulated string per lane.
 */

import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getOrCreateSessionApiKey, getValidToken } from "@/lib/auth/storage";
import { consumeAnthropicStream } from "@/lib/gateway/anthropicStream";
import { isValidModelId } from "@/lib/runtime";
import { getGatewayUrl } from "@/lib/runtime/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LANES = 4;
const MAX_PROMPT_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 60_000;

interface LaneRequest {
  id: string;
  model: string;
}

interface Body {
  prompt?: unknown;
  lanes?: unknown;
  /** Optional: cap response tokens. Defaults to 512. */
  maxTokens?: unknown;
}

export interface LaneResult {
  id: string;
  model: string;
  ok: boolean;
  /** Wall-clock time of the request in ms. */
  latencyMs: number;
  /** Assistant content, or empty string on failure. */
  content: string;
  /** Token usage if the gateway returned it. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  /** Number of tool/function call segments returned (if any). */
  toolCalls: number;
  error?: string;
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

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "missing_prompt" }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return NextResponse.json(
      { error: "prompt_too_long", limit: MAX_PROMPT_CHARS },
      { status: 400 },
    );
  }

  const lanes = parseLanes(body.lanes);
  if (lanes.length === 0) {
    return NextResponse.json({ error: "no_lanes" }, { status: 400 });
  }

  const maxTokens = clampInt(body.maxTokens, 16, 2048, 512);

  // Without a token the gateway has nothing to forward. Fail fast so
  // the UI can prompt re-auth instead of timing out per lane.
  const token = await getValidToken();
  if (!token) {
    return NextResponse.json(
      {
        error: "no_token",
        message: "sign in via Claude Codex to compare models",
      },
      { status: 401 },
    );
  }

  const apiKey = await getOrCreateSessionApiKey();

  const settled = await Promise.allSettled(
    lanes.map((lane) => runLane(lane, prompt, maxTokens, apiKey)),
  );

  const results: LaneResult[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    return {
      id: lanes[i].id,
      model: lanes[i].model,
      ok: false,
      latencyMs: 0,
      content: "",
      toolCalls: 0,
      error: (s.reason as Error)?.message ?? "lane crashed",
    };
  });

  return NextResponse.json({ lanes: results });
}

function parseLanes(raw: unknown): LaneRequest[] {
  if (!Array.isArray(raw)) return [];
  const out: LaneRequest[] = [];
  const seenIds = new Set<string>();
  for (const item of raw.slice(0, MAX_LANES)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const model = typeof r.model === "string" ? r.model.trim() : "";
    if (!isValidModelId(model)) continue;
    const rawId = typeof r.id === "string" ? r.id.trim() : "";
    let id = rawId && /^[\w\-]{1,32}$/.test(rawId) ? rawId : model;
    let i = 2;
    while (seenIds.has(id)) {
      id = `${model}#${i++}`;
    }
    seenIds.add(id);
    out.push({ id, model });
  }
  return out;
}

async function runLane(
  lane: LaneRequest,
  prompt: string,
  maxTokens: number,
  apiKey: string,
): Promise<LaneResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(getGatewayUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: lane.model,
        // Anthropic-shaped request — bin/gateway.js translates this
        // into the Codex Responses API. `system` is optional; we omit
        // it so the upstream system prompt baked into the gateway is
        // used as-is.
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: true,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      return {
        id: lane.id,
        model: lane.model,
        ok: false,
        latencyMs: Date.now() - t0,
        content: "",
        toolCalls: 0,
        error: `gateway ${res.status}: ${truncate(text, 200)}`,
      };
    }
    const parsed = await consumeAnthropicStream(res.body);
    return {
      id: lane.id,
      model: lane.model,
      ok: true,
      latencyMs: Date.now() - t0,
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      usage: parsed.usage,
    };
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    return {
      id: lane.id,
      model: lane.model,
      ok: false,
      latencyMs: Date.now() - t0,
      content: "",
      toolCalls: 0,
      error: aborted ? "timeout" : (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Anthropic SSE accumulator ──────────────────────────────────────── */

// Implementation lives in `@/lib/gateway/anthropicStream` so it can be
// unit-tested without dragging the route's `next/headers` imports
// into the vitest node env.

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
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
