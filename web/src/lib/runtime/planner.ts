/**
 * Planner — produces the next tool call (or a `done` signal) for the
 * auto-drive loop, given the current goal and step history.
 *
 * Live mode: posts an OpenAI-style chat completion to the local
 * gateway (`http://localhost:18923/v1/chat/completions`) using the
 * dummy session API key, asking the model to respond with strict
 * JSON describing the next action.
 *
 * Mock mode: when no token is available, falls back to a tiny
 * deterministic planner that exercises the loop without burning
 * credits — useful for sandboxes, tests, and the demo experience
 * before users authenticate.
 */

import { getValidToken, getOrCreateSessionApiKey } from "@/lib/auth/storage";

import type { AutoDriveStep } from "./store";

const GATEWAY_URL =
  process.env.MISSION_CONTROL_GATEWAY_URL ??
  "http://127.0.0.1:18923/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 20_000;

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
}

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

const SYSTEM_PROMPT = `You are the Mission Control auto-drive planner. \
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

async function livePlan(input: PlannerInput): Promise<Plan> {
  const apiKey = await getOrCreateSessionApiKey();
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: buildUserMessage(input),
    },
  ];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content?.trim() ?? "";
  return parsePlan(content);
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
  // Strip code fences if the model wrapped the JSON.
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const obj = JSON.parse(cleaned) as unknown;
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
