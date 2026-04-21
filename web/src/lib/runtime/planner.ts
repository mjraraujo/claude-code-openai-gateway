/**
 * Planner — produces the next tool call (or a `done` signal) for the
 * auto-drive loop, given the current goal and step history.
 *
 * Live mode: posts an Anthropic Messages-shaped request to the local
 * `claude-codex` gateway (`bin/gateway.js`). The gateway always
 * streams Server-Sent Events (`event: message_start /
 * content_block_delta / message_delta / message_stop`) — there is no
 * non-streaming JSON mode — so we drain the stream via
 * `consumeAnthropicStream()` and parse the accumulated text as JSON.
 *
 * Mock mode: when no token is available, falls back to a tiny
 * deterministic planner that exercises the loop without burning
 * credits — useful for sandboxes, tests, and the demo experience
 * before users authenticate.
 */

import { getValidToken, getOrCreateSessionApiKey } from "@/lib/auth/storage";
import { consumeAnthropicStream } from "@/lib/gateway/anthropicStream";

import { getGatewayUrl } from "./gateway";
import type { AutoDriveStep } from "./store";

const REQUEST_TIMEOUT_MS = 30_000;

export type PlanAction =
  | { tool: "read_file"; path: string }
  | { tool: "write_file"; path: string; content: string }
  | { tool: "exec"; command: string }
  | { tool: "done"; summary: string };

export interface Plan {
  thought: string;
  action: PlanAction;
}

export interface PlannerInput {
  goal: string;
  steps: AutoDriveStep[];
  maxStepsRemaining: number;
  /** Model id to send to the gateway. Falls back to the default. */
  model?: string;
  /**
   * Optional planning style toggles that flow from the Kanban panel
   * (Methodology + Dev Mode selectors). Surfaced to the model in the
   * system prompt so the operator's choice actually changes how the
   * loop plans, not just how it's labelled in the UI.
   */
  methodology?: string;
  devMode?: string;
}

export const DEFAULT_PLANNER_MODEL = "gpt-5.4";

export async function plan(input: PlannerInput): Promise<Plan> {
  const token = await getValidToken();
  if (!token) return mockPlan(input);
  try {
    return await livePlan(input);
  } catch {
    // If the gateway is unreachable or the model returned junk, fall
    // back to the mock so the loop terminates cleanly.
    return {
      thought: "live planner unavailable, ending run",
      action: { tool: "done", summary: "planner unavailable" },
    };
  }
}

const BASE_SYSTEM_PROMPT = `You are the Claude Codex auto-drive planner. \
Given a goal and a transcript of previous steps, decide the SINGLE next \
tool call. Respond with strict JSON only, no prose, matching this shape:

{"thought": string, "action": {"tool": "read_file"|"write_file"|"exec"|"done", ...args}}

Tool args:
- read_file: {"path": "relative/path"}
- write_file: {"path": "relative/path", "content": "full new file contents"}
- exec: {"command": "bash command line"}
- done: {"summary": "what was accomplished"}

Rules:
- Choose "done" as soon as the goal is satisfied or appears infeasible.
- Paths are relative to the gateway repo root. Never use absolute paths.
- Keep commands fast (<30s). Output is truncated past 64 KB.
- Prefer reading before writing. Prefer small, focused changes.`;

/** Build the system prompt with optional methodology/dev-mode hints. */
export function buildSystemPrompt(input: {
  methodology?: string;
  devMode?: string;
}): string {
  const extras: string[] = [];
  if (input.methodology && input.methodology.trim()) {
    extras.push(`Methodology: ${input.methodology.trim()} — bias your planning toward this workflow.`);
  }
  if (input.devMode && input.devMode.trim()) {
    extras.push(`Dev mode: ${input.devMode.trim()} — adjust caution and review depth accordingly.`);
  }
  if (extras.length === 0) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}\n\n${extras.join("\n")}`;
}

async function livePlan(input: PlannerInput): Promise<Plan> {
  const apiKey = await getOrCreateSessionApiKey();
  const system = buildSystemPrompt({
    methodology: input.methodology,
    devMode: input.devMode,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(getGatewayUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:
          input.model && input.model.trim()
            ? input.model
            : DEFAULT_PLANNER_MODEL,
        system,
        messages: [{ role: "user", content: buildUserMessage(input) }],
        max_tokens: 1024,
        temperature: 0.2,
        stream: true,
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || !res.body) throw new Error(`gateway ${res.status}`);
  // Drain the Anthropic-shaped SSE stream into one accumulated string,
  // then parse it as JSON. The gateway has no JSON-only mode, so this
  // is the supported shape.
  const parsed = await consumeAnthropicStream(res.body);
  return parsePlan(parsed.content);
}

function buildUserMessage(input: PlannerInput): string {
  const transcript = input.steps
    .slice(-12)
    .map((s) => `[${s.kind}] ${s.text}`)
    .join("\n");
  return [
    `GOAL: ${input.goal}`,
    `STEPS REMAINING: ${input.maxStepsRemaining}`,
    "TRANSCRIPT:",
    transcript || "(empty)",
    "",
    "Respond with the JSON plan for the next single step.",
  ].join("\n");
}

function parsePlan(raw: string): Plan {
  // The model may wrap the JSON in code fences, prepend prose, or
  // emit extra trailing text. Try to recover the JSON object that
  // looks most like a plan before parsing.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const candidate = extractJsonObject(cleaned) ?? cleaned;
  const obj = JSON.parse(candidate) as unknown;
  if (!obj || typeof obj !== "object") throw new Error("plan not an object");
  const thought = String((obj as Record<string, unknown>).thought ?? "");
  const action = (obj as Record<string, unknown>).action as
    | Record<string, unknown>
    | undefined;
  if (!action || typeof action !== "object") {
    throw new Error("plan missing action");
  }
  const tool = String(action.tool);
  switch (tool) {
    case "read_file":
      return { thought, action: { tool, path: String(action.path ?? "") } };
    case "write_file":
      return {
        thought,
        action: {
          tool,
          path: String(action.path ?? ""),
          content: String(action.content ?? ""),
        },
      };
    case "exec":
      return {
        thought,
        action: { tool, command: String(action.command ?? "") },
      };
    case "done":
      return {
        thought,
        action: { tool, summary: String(action.summary ?? "") },
      };
    default:
      throw new Error(`unknown tool ${tool}`);
  }
}

/* ─── Mock planner ──────────────────────────────────────────────────── */

/**
 * Slice out the outermost balanced `{ … }` object from a string, so
 * we can recover the plan JSON even when the model emitted prose
 * before/after it. Returns null if no balanced object is found.
 *
 * Exported for unit tests — the actual call site is internal to
 * `parsePlan` below.
 */
export function extractJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * A small state machine: read the README, print the file tree, then
 * declare done. Lets the loop demo end-to-end with no LLM behind it.
 */
function mockPlan(input: PlannerInput): Plan {
  const last = input.steps[input.steps.length - 1];
  if (!input.steps.length) {
    return {
      thought: "starting — survey the workspace by reading README.md",
      action: { tool: "read_file", path: "README.md" },
    };
  }
  // Find prior tool calls.
  const prior = input.steps.filter((s) => s.kind === "tool").map((s) => {
    const data = s.data as { tool?: string } | undefined;
    return data?.tool ?? "";
  });
  if (!prior.includes("exec")) {
    return {
      thought: "list top-level files to understand layout",
      action: { tool: "exec", command: "ls -la | head -30" },
    };
  }
  return {
    thought: "demo complete — terminating cleanly",
    action: {
      tool: "done",
      summary: `mock planner done after ${input.steps.length} steps; last=${last?.kind ?? "n/a"}`,
    },
  };
}
