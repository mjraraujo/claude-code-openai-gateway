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
 */

import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getOrCreateSessionApiKey, getValidToken } from "@/lib/auth/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATEWAY_URL =
  process.env.MISSION_CONTROL_GATEWAY_URL ??
  "http://127.0.0.1:18923/v1/chat/completions";

const MAX_LANES = 4;
const MAX_PROMPT_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 60_000;
const MODEL_RE = /^[\w.\-:/]{1,64}$/;

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
        message: "sign in via Mission Control to compare models",
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
    if (!model || !MODEL_RE.test(model)) continue;
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
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: lane.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        id: lane.id,
        model: lane.model,
        ok: false,
        latencyMs,
        content: "",
        toolCalls: 0,
        error: `gateway ${res.status}: ${truncate(text, 200)}`,
      };
    }
    const json = (await res.json()) as ChatResponse;
    const choice = json.choices?.[0];
    const content = (choice?.message?.content ?? "").toString();
    const toolCalls = Array.isArray(choice?.message?.tool_calls)
      ? (choice?.message?.tool_calls?.length ?? 0)
      : 0;
    return {
      id: lane.id,
      model: lane.model,
      ok: true,
      latencyMs,
      content,
      toolCalls,
      usage: json.usage,
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

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: unknown[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

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
