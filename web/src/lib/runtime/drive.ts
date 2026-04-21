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
  personaAgentId,
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
  /**
   * Optional override of the planner model. If omitted, the persisted
   * `harness.model` from the store is used.
   */
  model?: string;
}

const DEFAULTS = {
  maxSteps: 12,
  maxWallMs: 5 * 60 * 1000,
  maxBytes: 1 * 1024 * 1024,
};

/**
 * Circuit-breaker configuration for the auto-drive loop. The planner
 * occasionally gets stuck either (a) re-emitting the same tool call
 * repeatedly without making progress (the "infinite jump"), or
 * (b) producing tool calls that all fail. Both modes burn the step
 * and byte budgets without ever finishing, so we trip a breaker that
 * terminates the run with a clear reason instead of waiting for the
 * outer guardrails.
 *
 * Defaults are intentionally conservative: a real plan that legitimately
 * needs to retry the same tool 2-3 times will not trip, but a planner
 * stuck in a loop is caught well before the 12-step default.
 */
export interface CircuitBreakerConfig {
  /** Trip after this many consecutive identical plan signatures. */
  maxRepeatedPlans: number;
  /** Trip after this many consecutive failed tool_result steps. */
  maxConsecutiveFailures: number;
}

export const DEFAULT_BREAKER: CircuitBreakerConfig = {
  maxRepeatedPlans: 3,
  maxConsecutiveFailures: 4,
};

interface ActiveLoop {
  runId: string;
  abort: AbortController;
  options: Required<Omit<StartOptions, "model">> & { model: string };
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

  const initialSnap = await getStore().snapshot();
  const model = (opts.model ?? initialSnap.harness.model ?? "").trim() || "gpt-5.3-codex";

  const options: ActiveLoop["options"] = {
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
    model,
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
    setAgentStatus(draft, personaAgentId(draft.harness.persona), "active", "drive.plan");
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

/**
 * Recover from a stuck `active` singleton by forcing it back to null
 * even if the corresponding run can't be reconciled. Callable from
 * the UI's "Force stop" button to unwedge runs whose loop crashed in
 * a way that bypassed the normal termination path.
 */
export async function forceClearAutoDrive(reason = "force-cleared"): Promise<void> {
  const a = active;
  if (a) {
    try {
      a.abort.abort();
    } catch {
      /* ignore */
    }
    await terminate(a.runId, "stopped", reason);
  }
  // Belt and braces: even if `active` was null on entry, scrub any
  // dangling `current` left over by a crashed previous process.
  await getStore().update((draft) => {
    if (draft.autoDrive.current) {
      const cur = draft.autoDrive.current;
      cur.status = "stopped";
      cur.endedAt = Date.now();
      cur.reason = reason;
      draft.autoDrive.history = [cur, ...draft.autoDrive.history].slice(0, 10);
      draft.autoDrive.current = null;
    }
  });
  active = null;
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
        // Re-read methodology/devMode from the store on every step
        // so the user can change them mid-run via the Kanban panel.
        const live = await getStore().snapshot();
        p = await plan({
          goal: a.options.goal,
          steps: run.steps,
          maxStepsRemaining: a.options.maxSteps - stepIndex,
          model: a.options.model,
          methodology: live.harness.methodology,
          devMode: live.harness.devMode,
          persona: live.harness.persona,
        });
      } catch (err) {
        await appendStep(a.runId, "error", `planner error: ${(err as Error).message}`);
        return await terminate(a.runId, "error", "planner failed");
      }
      if (a.abort.signal.aborted) return;

      stepIndex++;
      await appendStep(a.runId, "plan", p.thought, {
        tool: p.action.tool,
        sig: planSignature(p.action),
      });

      // Circuit-breaker: catch the planner repeating itself before
      // we burn another tool execution on the same call.
      {
        const after = await getStore().snapshot();
        const cur = after.autoDrive.current;
        if (cur && cur.id === a.runId) {
          const verdict = detectCircuitBreaker(cur.steps);
          if (verdict.tripped) {
            await appendStep(a.runId, "error", verdict.reason);
            return await terminate(a.runId, "error", verdict.reason);
          }
        }
      }

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

      // Circuit-breaker: catch a streak of failing tool calls so we
      // don't keep retrying a broken command until the step budget
      // is exhausted.
      {
        const after = await getStore().snapshot();
        const cur = after.autoDrive.current;
        if (cur && cur.id === a.runId) {
          const verdict = detectCircuitBreaker(cur.steps);
          if (verdict.tripped) {
            await appendStep(a.runId, "error", verdict.reason);
            return await terminate(a.runId, "error", verdict.reason);
          }
        }
      }
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

/**
 * Stable string fingerprint of a planner action, used by the circuit
 * breaker to detect "infinite jumps" where the planner keeps emitting
 * the same call. Includes the tool name and the operative arguments
 * (path / command / content hash / summary). Whitespace in commands
 * is normalised so trivially-different reformattings still collapse.
 */
export function planSignature(action: PlanAction): string {
  switch (action.tool) {
    case "read_file":
      return `read_file::${action.path}`;
    case "write_file":
      // Don't fingerprint the full content (large files would blow
      // up the comparison) — length + first/last 64 bytes is enough
      // to distinguish "same plan" from "different plan" in practice.
      return `write_file::${action.path}::${action.content.length}::${
        action.content.slice(0, 64)
      }::${action.content.slice(-64)}`;
    case "exec":
      return `exec::${action.command.replace(/\s+/g, " ").trim()}`;
    case "done":
      return `done::${action.summary.trim()}`;
  }
}

export type BreakerVerdict =
  | { tripped: false }
  | { tripped: true; reason: string };

/**
 * Pure circuit-breaker check. Inspects the tail of the step history
 * and returns whether the loop should be terminated. Two trip
 * conditions:
 *
 *   1. The last `maxRepeatedPlans` plan steps all share the same
 *      `planSignature` — the planner is stuck repeating itself.
 *   2. The last `maxConsecutiveFailures` `tool_result` steps all have
 *      `data.ok === false` — every tool call is failing.
 *
 * Both checks ignore `info` / `error` housekeeping steps so a stray
 * info log doesn't reset the failure streak.
 */
export function detectCircuitBreaker(
  steps: AutoDriveStep[],
  cfg: CircuitBreakerConfig = DEFAULT_BREAKER,
): BreakerVerdict {
  const repeatN = Math.max(2, cfg.maxRepeatedPlans);
  const failN = Math.max(2, cfg.maxConsecutiveFailures);

  // (1) Repeated-plan check.
  const planSigs: string[] = [];
  for (let i = steps.length - 1; i >= 0 && planSigs.length < repeatN; i--) {
    const s = steps[i];
    if (s.kind !== "plan") continue;
    const sig = typeof s.data?.sig === "string"
      ? s.data.sig
      // Fallback for plan steps that pre-date the breaker: combine
      // tool name + (capped) thought text so the check still works
      // on historical runs loaded from disk without producing
      // arbitrarily long signature strings.
      : `${typeof s.data?.tool === "string" ? s.data.tool : "plan"}::${s.text.trim().slice(0, 100)}`;
    planSigs.push(sig);
  }
  if (planSigs.length >= repeatN && planSigs.every((s) => s === planSigs[0])) {
    return {
      tripped: true,
      reason: `circuit breaker: ${repeatN} consecutive identical plans`,
    };
  }

  // (2) Consecutive-failure check.
  const results: boolean[] = [];
  for (let i = steps.length - 1; i >= 0 && results.length < failN; i--) {
    const s = steps[i];
    if (s.kind !== "tool_result") continue;
    results.push(s.data?.ok === true);
  }
  if (results.length >= failN && results.every((ok) => ok === false)) {
    return {
      tripped: true,
      reason: `circuit breaker: ${failN} consecutive tool failures`,
    };
  }

  return { tripped: false };
}
