/**
 * Auto-drive execution engine.
 *
 * Responsibilities:
 *   - Hold the singleton "current run" — only one auto-drive run can
 *     be active at a time.
 *   - Loop: ask planner → execute tool → record step → repeat, with
 *     hard guardrails on step count, wall time, and emitted bytes.
 *   - Provide `start()` / `stop()` that survive request boundaries
 *     (the loop keeps running after the start request returns).
 */

import { plan, type PlanAction } from "./planner";
import { execCommand, readFile, writeFile } from "./tools";
import {
  AutoDriveRun,
  AutoDriveStep,
  AutoDriveStepKind,
  getStore,
  newId,
  RuntimeState,
} from "./store";

export interface StartOptions {
  goal: string;
  /** Defaults to 12 — keep small unless explicitly raised. */
  maxSteps?: number;
  /** Defaults to 5 minutes. */
  maxWallMs?: number;
  /** Defaults to 1 MB. Counts tool output bytes accumulated. */
  maxBytes?: number;
}

const DEFAULTS = {
  maxSteps: 12,
  maxWallMs: 5 * 60 * 1000,
  maxBytes: 1 * 1024 * 1024,
};

interface ActiveLoop {
  runId: string;
  abort: AbortController;
  options: Required<StartOptions>;
}

let active: ActiveLoop | null = null;

/** Returns the active run id (if any) — useful for tests. */
export function currentRunId(): string | null {
  return active?.runId ?? null;
}

export async function startAutoDrive(opts: StartOptions): Promise<AutoDriveRun> {
  if (active) {
    throw new Error("auto_drive_already_running");
  }
  const goal = (opts.goal ?? "").trim();
  if (!goal) throw new Error("missing_goal");

  const options: Required<StartOptions> = {
    goal,
    maxSteps: clampInt(opts.maxSteps, 1, 50, DEFAULTS.maxSteps),
    maxWallMs: clampInt(
      opts.maxWallMs,
      5_000,
      30 * 60 * 1000,
      DEFAULTS.maxWallMs,
    ),
    maxBytes: clampInt(
      opts.maxBytes,
      1024,
      8 * 1024 * 1024,
      DEFAULTS.maxBytes,
    ),
  };

  const runId = newId("drv");
  const run: AutoDriveRun = {
    id: runId,
    goal,
    startedAt: Date.now(),
    status: "running",
    steps: [],
    bytesEmitted: 0,
  };

  await getStore().update((draft) => {
    draft.autoDrive.current = run;
    setAgentStatus(draft, "ruflo-core", "active", "drive.plan");
    setAgentStatus(draft, "harness", "active", "supervise");
  });

  const ctrl = new AbortController();
  active = { runId, abort: ctrl, options };
  // Fire-and-forget; the loop drives the store.
  runLoop(active).catch((err) => {
    // Last-resort safety net.
    void terminate(runId, "error", `loop crashed: ${(err as Error).message}`);
  });

  return run;
}

export async function stopAutoDrive(reason = "stopped by user"): Promise<void> {
  const a = active;
  if (!a) return;
  a.abort.abort();
  await terminate(a.runId, "stopped", reason);
}

async function runLoop(a: ActiveLoop): Promise<void> {
  const startedAt = Date.now();
  let stepIndex = 0;

  try {
    for (;;) {
      if (a.abort.signal.aborted) return;
      if (stepIndex >= a.options.maxSteps) {
        return await terminate(a.runId, "completed", "max steps reached");
      }
      if (Date.now() - startedAt > a.options.maxWallMs) {
        return await terminate(a.runId, "completed", "wall-time budget exhausted");
      }

      const snap = await getStore().snapshot();
      const run = snap.autoDrive.current;
      if (!run || run.id !== a.runId) return; // run was cleared
      if (run.bytesEmitted > a.options.maxBytes) {
        return await terminate(a.runId, "completed", "byte budget exhausted");
      }

      // 1. Plan
      let p;
      try {
        p = await plan({
          goal: a.options.goal,
          steps: run.steps,
          maxStepsRemaining: a.options.maxSteps - stepIndex,
        });
      } catch (err) {
        await appendStep(a.runId, "error", `planner error: ${(err as Error).message}`);
        return await terminate(a.runId, "error", "planner failed");
      }
      if (a.abort.signal.aborted) return;

      stepIndex++;
      await appendStep(a.runId, "plan", p.thought, { tool: p.action.tool });

      // 2. Execute
      if (p.action.tool === "done") {
        await appendStep(a.runId, "info", p.action.summary);
        return await terminate(a.runId, "completed", p.action.summary);
      }

      await appendStep(
        a.runId,
        "tool",
        describeAction(p.action),
        { tool: p.action.tool, args: redactArgs(p.action) },
      );
      const result = await executeTool(p.action);
      if (a.abort.signal.aborted) return;
      const text = result.ok
        ? truncate(result.output ?? "", 2000)
        : `ERR: ${result.error ?? "unknown"}`;
      await appendStep(a.runId, "tool_result", text, {
        ok: result.ok,
        bytes: (result.output ?? "").length,
      });
    }
  } catch (err) {
    await terminate(a.runId, "error", (err as Error).message);
  }
}

async function executeTool(action: PlanAction) {
  switch (action.tool) {
    case "read_file":
      return readFile(action.path);
    case "write_file":
      return writeFile(action.path, action.content);
    case "exec":
      return execCommand(action.command);
    case "done":
      return { ok: true, output: action.summary };
  }
}

async function appendStep(
  runId: string,
  kind: AutoDriveStepKind,
  text: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await getStore().update((draft) => {
    const cur = draft.autoDrive.current;
    if (!cur || cur.id !== runId) return;
    const step: AutoDriveStep = {
      index: cur.steps.length,
      at: Date.now(),
      kind,
      text,
      data,
    };
    cur.steps.push(step);
    if (kind === "tool_result") {
      cur.bytesEmitted += text.length;
    }
  });
}

async function terminate(
  runId: string,
  status: "completed" | "stopped" | "error",
  reason: string,
): Promise<void> {
  if (active?.runId === runId) active = null;
  await getStore().update((draft) => {
    const cur = draft.autoDrive.current;
    if (!cur || cur.id !== runId) {
      // Already terminated.
      idleAgents(draft);
      return;
    }
    cur.status = status;
    cur.endedAt = Date.now();
    cur.reason = reason;
    draft.autoDrive.history = [cur, ...draft.autoDrive.history].slice(0, 10);
    draft.autoDrive.current = null;
    idleAgents(draft);
  });
}

function setAgentStatus(
  draft: RuntimeState,
  id: string,
  status: "active" | "idle" | "blocked",
  skill: string,
): void {
  const a = draft.agents.find((x) => x.id === id);
  if (a) {
    a.status = status;
    a.skill = skill;
  }
}

function idleAgents(draft: RuntimeState): void {
  for (const a of draft.agents) {
    a.status = "idle";
    a.skill = "—";
  }
}

function describeAction(action: PlanAction): string {
  switch (action.tool) {
    case "read_file":
      return `read_file ${action.path}`;
    case "write_file":
      return `write_file ${action.path} (${action.content.length}b)`;
    case "exec":
      return `exec ${truncate(action.command, 120)}`;
    case "done":
      return `done: ${action.summary}`;
  }
}

function redactArgs(action: PlanAction): Record<string, unknown> {
  switch (action.tool) {
    case "write_file":
      return { path: action.path, contentBytes: action.content.length };
    case "read_file":
      return { path: action.path };
    case "exec":
      return { command: action.command };
    case "done":
      return { summary: action.summary };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n... [truncated]` : s;
}

function clampInt(
  raw: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}
