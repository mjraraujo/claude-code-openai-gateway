/**
 * Chat-agent tool-calling loop.
 *
 * The legacy `POST /api/runtime/chat` was a bare SSE pass-through to
 * the local gateway — chat had no tools, which is why operators saw
 * the planner give up with "refusing to create new file" the moment
 * a request needed any filesystem access. This module wraps the same
 * planner the auto-drive loop uses (`./planner`) around the tool
 * harness in `./tools` so the chat surface can actually create
 * files, run commands, and inspect the workspace.
 *
 * It is intentionally factored separately from `drive.ts`:
 *  - `drive.ts` runs in the background, persists every step on the
 *    runtime store, and owns auto-drive bookkeeping (`AutoDriveRun`,
 *    circuit breaker, history).
 *  - This loop is short-lived per HTTP request, returns events to a
 *    single client over SSE, and never touches `autoDrive.current` —
 *    so chat use cannot collide with an in-flight `▶ run`.
 *
 * Event vocabulary streamed to the client:
 *  - `thought`     – planner reasoning for the next step
 *  - `tool_call`   – about to execute a tool
 *  - `tool_result` – outcome with the same `{ok,output,error,code,hint}` envelope as `tools.ts`
 *  - `message`     – final assistant message text (when planner says `done`)
 *  - `done`        – terminal frame with summary + step count
 *  - `error`       – fatal loop error (timeout, planner failure, …)
 */

import type { AutoDriveStep } from "./store";
import { plan, type Plan } from "./planner";
import {
  execCommand,
  readFile,
  writeFile,
  type ToolResult,
} from "./tools";

export interface ChatAgentOptions {
  /** The user's request, used as the planner goal. */
  goal: string;
  /** Model id forwarded to the planner. */
  model: string;
  /** Optional methodology / dev-mode / persona hints passed through to the system prompt. */
  methodology?: string;
  devMode?: string;
  persona?: import("./store").RufloPersona;
  /** Hard cap on planning steps. Default 6 — chat is not auto-drive. */
  maxSteps?: number;
  /** Hard wall-clock cap. Default 60 s. */
  maxWallMs?: number;
  /** Abort signal from the upstream HTTP request. */
  signal?: AbortSignal;
}

export type ChatAgentEvent =
  | { type: "thought"; text: string }
  | {
      type: "tool_call";
      tool: string;
      /**
       * Sanitised summary of the tool args (path, command, …). We
       * deliberately do NOT echo full file `content` back over the
       * wire — the client doesn't need it (the planner does), and it
       * blows the SSE message size out for large writes.
       */
      summary: string;
    }
  | {
      type: "tool_result";
      tool: string;
      ok: boolean;
      /** Truncated output / error preview for the chat UI. */
      preview: string;
      code?: string;
      hint?: string;
    }
  | { type: "message"; content: string }
  | { type: "done"; summary: string; steps: number }
  | { type: "error"; message: string };

const DEFAULT_MAX_STEPS = 6;
const DEFAULT_MAX_WALL_MS = 60_000;
/** Cap on the per-event preview text shown to the chat user. */
const PREVIEW_CHARS = 600;

/**
 * Run the agent loop and yield events. Generator-based so the route
 * handler can pipe each event straight into an SSE stream without
 * buffering, and so tests can drive the loop synchronously without
 * setting up a fake HTTP client.
 */
export async function* runChatAgent(
  opts: ChatAgentOptions,
): AsyncGenerator<ChatAgentEvent, void, void> {
  const goal = (opts.goal ?? "").trim();
  if (!goal) {
    yield { type: "error", message: "missing goal" };
    return;
  }
  const maxSteps = Math.min(Math.max(1, opts.maxSteps ?? DEFAULT_MAX_STEPS), 12);
  const maxWallMs = Math.min(
    Math.max(5_000, opts.maxWallMs ?? DEFAULT_MAX_WALL_MS),
    300_000,
  );
  const startedAt = Date.now();
  const steps: AutoDriveStep[] = [];

  for (let i = 0; i < maxSteps; i++) {
    if (opts.signal?.aborted) {
      yield { type: "error", message: "client disconnected" };
      return;
    }
    if (Date.now() - startedAt > maxWallMs) {
      yield { type: "error", message: "wall-time budget exceeded" };
      return;
    }

    let p: Plan;
    try {
      p = await plan({
        goal,
        steps,
        maxStepsRemaining: maxSteps - i,
        model: opts.model,
        methodology: opts.methodology,
        devMode: opts.devMode,
        persona: opts.persona,
      });
    } catch (err) {
      yield { type: "error", message: `planner failed: ${(err as Error).message}` };
      return;
    }

    yield { type: "thought", text: p.thought };
    steps.push({
      index: steps.length,
      at: Date.now(),
      kind: "plan",
      text: p.thought,
      data: { tool: p.action.tool },
    });

    if (p.action.tool === "done") {
      const summary = p.action.summary || "(no summary)";
      yield { type: "message", content: summary };
      yield { type: "done", summary, steps: steps.length };
      return;
    }

    yield {
      type: "tool_call",
      tool: p.action.tool,
      summary: summariseAction(p.action),
    };

    let result: ToolResult;
    try {
      switch (p.action.tool) {
        case "read_file":
          result = await readFile(p.action.path);
          break;
        case "write_file":
          result = await writeFile(p.action.path, p.action.content);
          break;
        case "exec":
          result = await execCommand(p.action.command);
          break;
        default:
          // The chat surface deliberately exposes only the core
          // read / write / exec tools. Feature / cucumber / deploy
          // belong to the endless-drive SDLC engine and should not
          // be reachable from a chat turn.
          result = {
            ok: false,
            code: "command_blocked",
            error: `tool not available in chat: ${p.action.tool}`,
            hint: "use read_file / write_file / exec from chat — feature/cucumber/deploy are reserved for auto-drive runs.",
          };
      }
    } catch (err) {
      result = { ok: false, error: (err as Error).message, code: "io_error" };
    }

    yield {
      type: "tool_result",
      tool: p.action.tool,
      ok: result.ok,
      preview: previewResult(result),
      code: result.code,
      hint: result.hint,
    };
    steps.push({
      index: steps.length,
      at: Date.now(),
      kind: "tool_result",
      text: result.ok
        ? truncate(result.output ?? "ok", 800)
        : `err${result.code ? `[${result.code}]` : ""}: ${truncate(result.error ?? "", 400)}${result.hint ? `\nhint: ${truncate(result.hint, 200)}` : ""}`,
    });
  }

  yield {
    type: "done",
    summary: `step budget (${maxSteps}) exhausted`,
    steps: steps.length,
  };
}

/**
 * Pure helper, exported for tests. Produces a one-line, user-safe
 * summary of a planner action — never echoing file content or full
 * command pipelines (we don't want a 100 KB write to flood the SSE
 * stream).
 */
export function summariseAction(action: Plan["action"]): string {
  switch (action.tool) {
    case "read_file":
      return `read ${action.path}`;
    case "write_file":
      return `write ${action.path} (${action.content.length} chars)`;
    case "exec":
      return `exec ${truncate(action.command, 120)}`;
    case "feature_file":
      return `feature ${action.path}`;
    case "cucumber":
      return `cucumber ${action.path ?? "features"}`;
    case "deploy":
      return `deploy ${action.environment ?? ""}`.trim();
    case "done":
      return `done: ${truncate(action.summary, 120)}`;
  }
}

function previewResult(r: ToolResult): string {
  if (r.ok) return truncate(r.output ?? "ok", PREVIEW_CHARS);
  const head = r.error ?? "error";
  const tail = r.hint ? `\nhint: ${r.hint}` : "";
  return truncate(head, PREVIEW_CHARS) + tail;
}

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n… [+${s.length - limit} chars]`;
}
