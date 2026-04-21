/**
 * Auto-drive v2 — multi-agent endless SDLC loop.
 *
 * Differences from `drive.ts` (the original "bounded" engine):
 *
 *   - **No step / wall-time / byte caps.** Endless mode is meant to
 *     keep planning until either every SDLC gate is green or the
 *     operator hits the kill switch.
 *   - **Larger circuit breaker thresholds.** Re-uses the breaker
 *     from `drive.ts` but with `ENDLESS_BREAKER` so a multi-stage run
 *     that legitimately retries the same tool for several iterations
 *     across personas isn't tripped prematurely.
 *   - **Persona round-robin.** Each step rotates `core → impl →
 *     review → core …` so all three perspectives weigh in over the
 *     run rather than the operator having to flip the persona toggle
 *     manually.
 *   - **SDLC stage tracking.** A pure state machine
 *     (`./sdlc.ts`) walks `spec → bdd → impl → test → deploy →
 *     delivered`. The planner's `done` action advances the stage; the
 *     loop only terminates when the machine reports `delivered`.
 *
 * The two engines share the same `active` singleton (so the kill
 * switch in the UI works against either one) and the same
 * `getStore()` mutations.
 */

import { plan } from "./planner";
import type { PlanAction } from "./planner";
import {
  detectCircuitBreaker,
  type CircuitBreakerConfig,
} from "./drive";
import {
  INITIAL_SDLC_STATE,
  isDelivered,
  personaForStep,
  recordGate,
  stagePromptHint,
  type SdlcState,
} from "./sdlc";
import {
  execCommand,
  readFile,
  runCucumber,
  runDeploy,
  writeFeatureFile,
  writeFile,
} from "./tools";
import {
  AutoDriveRun,
  AutoDriveStep,
  AutoDriveStepKind,
  getStore,
  newId,
  personaAgentId,
  RuntimeState,
} from "./store";

export interface StartV2Options {
  goal: string;
  /**
   * Optional override of the planner model. If omitted, the persisted
   * `harness.model` from the store is used.
   */
  model?: string;
}

/**
 * Endless-mode breaker thresholds. Bigger than the bounded defaults
 * because a multi-persona run will legitimately revisit the same
 * stage multiple times as personas hand off.
 */
export const ENDLESS_BREAKER: CircuitBreakerConfig = {
  maxRepeatedPlans: 6,
  maxConsecutiveFailures: 8,
};

interface ActiveLoop {
  runId: string;
  abort: AbortController;
  goal: string;
  model: string;
}

let active: ActiveLoop | null = null;

export function currentRunId(): string | null {
  return active?.runId ?? null;
}

export async function startEndlessDrive(
  opts: StartV2Options,
): Promise<AutoDriveRun> {
  if (active) throw new Error("auto_drive_already_running");
  const goal = (opts.goal ?? "").trim();
  if (!goal) throw new Error("missing_goal");

  const initialSnap = await getStore().snapshot();
  const model =
    (opts.model ?? initialSnap.harness.model ?? "").trim() || "gpt-5.3-codex";

  const runId = newId("drv");
  const sdlc: SdlcState = structuredClone(INITIAL_SDLC_STATE);
  const run: AutoDriveRun = {
    id: runId,
    goal,
    startedAt: Date.now(),
    status: "running",
    steps: [],
    bytesEmitted: 0,
    mode: "endless",
    sdlc,
  };

  await getStore().update((draft) => {
    draft.autoDrive.current = run;
    // Light up all three persona rows so the UI shows the round-robin.
    for (const id of ["ruflo-core", "ruflo-impl", "ruflo-review"]) {
      setAgentStatus(draft, id, "active", "drive.endless");
    }
    setAgentStatus(draft, "harness", "active", "supervise");
  });

  const ctrl = new AbortController();
  active = { runId, abort: ctrl, goal, model };
  runLoop(active).catch((err) => {
    void terminate(runId, "error", `loop crashed: ${(err as Error).message}`);
  });
  return run;
}

export async function stopEndlessDrive(
  reason = "stopped by user",
): Promise<void> {
  const a = active;
  if (!a) return;
  a.abort.abort();
  await terminate(a.runId, "stopped", reason);
}

async function runLoop(a: ActiveLoop): Promise<void> {
  let stepIndex = 0;

  try {
    for (;;) {
      if (a.abort.signal.aborted) return;

      const snap = await getStore().snapshot();
      const run = snap.autoDrive.current;
      if (!run || run.id !== a.runId) return;
      const sdlc = run.sdlc ?? structuredClone(INITIAL_SDLC_STATE);

      // Terminal: every gate green.
      if (isDelivered(sdlc)) {
        return await terminate(a.runId, "completed", "delivered");
      }

      // 1. Plan, with the persona for this step + the SDLC hint.
      const persona = personaForStep(stepIndex);
      let p;
      try {
        p = await plan({
          goal: a.goal,
          steps: run.steps,
          // Endless mode has no remaining-step budget; surface a
          // sentinel large value so the planner doesn't try to
          // "wrap up" prematurely.
          maxStepsRemaining: 9999,
          model: a.model,
          methodology: snap.harness.methodology,
          devMode: appendStageHint(snap.harness.devMode, sdlc.stage),
          persona,
        });
      } catch (err) {
        await appendStep(
          a.runId,
          "error",
          `planner error: ${(err as Error).message}`,
        );
        return await terminate(a.runId, "error", "planner failed");
      }
      if (a.abort.signal.aborted) return;

      stepIndex++;
      // Mirror the active persona row in the UI so the operator can
      // see the rotation in real time.
      await getStore().update((draft) => {
        for (const id of ["ruflo-core", "ruflo-impl", "ruflo-review"]) {
          setAgentStatus(
            draft,
            id,
            id === personaAgentId(persona) ? "active" : "idle",
            id === personaAgentId(persona) ? `drive.${sdlc.stage}` : "—",
          );
        }
      });

      await appendStep(a.runId, "plan", `[${persona}@${sdlc.stage}] ${p.thought}`, {
        tool: p.action.tool,
        sig: planSignatureV2(p.action),
        persona,
        stage: sdlc.stage,
      });

      // Circuit breaker.
      {
        const after = await getStore().snapshot();
        const cur = after.autoDrive.current;
        if (cur && cur.id === a.runId) {
          const verdict = detectCircuitBreaker(cur.steps, ENDLESS_BREAKER);
          if (verdict.tripped) {
            await appendStep(a.runId, "error", verdict.reason);
            return await terminate(a.runId, "error", verdict.reason);
          }
        }
      }

      // 2. Execute. Treat `done` as "this stage is finished" rather
      //    than "the whole run is finished".
      if (p.action.tool === "done") {
        await appendStep(
          a.runId,
          "info",
          `stage ${sdlc.stage} marked done by planner: ${p.action.summary}`,
        );
        await advanceSdlc(a.runId, "green");
        continue;
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

      // Stage-gating side effects: certain successful tools advance
      // the SDLC machine without waiting for the planner to emit
      // `done`. Keeps the loop honest about progress instead of
      // depending on the model self-reporting.
      if (result.ok) {
        if (p.action.tool === "feature_file" && sdlc.stage === "bdd") {
          await advanceSdlc(a.runId, "green");
        } else if (p.action.tool === "cucumber" && sdlc.stage === "test") {
          await advanceSdlc(a.runId, "green");
        } else if (p.action.tool === "deploy" && sdlc.stage === "deploy") {
          await advanceSdlc(a.runId, "green");
        }
      } else if (
        (p.action.tool === "cucumber" && sdlc.stage === "test") ||
        (p.action.tool === "deploy" && sdlc.stage === "deploy")
      ) {
        // Mark the gate red but DO NOT advance — the loop will keep
        // planning until cucumber goes green or the breaker trips.
        await advanceSdlc(a.runId, "red");
      }

      // Circuit breaker after the tool run too.
      {
        const after = await getStore().snapshot();
        const cur = after.autoDrive.current;
        if (cur && cur.id === a.runId) {
          const verdict = detectCircuitBreaker(cur.steps, ENDLESS_BREAKER);
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
    case "feature_file":
      return writeFeatureFile(action.path, action.content);
    case "cucumber":
      return runCucumber(action.path);
    case "deploy":
      return runDeploy(action.environment);
    case "done":
      return { ok: true, output: action.summary };
  }
}

/**
 * Mutate the persisted SDLC state for the active run. Pulled into
 * its own helper so the loop body stays readable; uses `recordGate`
 * (pure) under the hood.
 */
async function advanceSdlc(
  runId: string,
  status: "green" | "red",
): Promise<void> {
  await getStore().update((draft) => {
    const cur = draft.autoDrive.current;
    if (!cur || cur.id !== runId) return;
    const sdlc = cur.sdlc ?? structuredClone(INITIAL_SDLC_STATE);
    cur.sdlc = recordGate(sdlc, status);
  });
}

function appendStageHint(
  devMode: string | undefined,
  stage: SdlcState["stage"],
): string {
  // Splice the SDLC hint into the dev-mode label so it flows through
  // `buildSystemPrompt` without us having to widen the planner API.
  const base = (devMode ?? "").trim();
  const hint = stagePromptHint(stage);
  return base ? `${base} · ${hint}` : hint;
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
    case "feature_file":
      return `feature_file ${action.path} (${action.content.length}b)`;
    case "cucumber":
      return `cucumber ${action.path ?? "(default)"}`;
    case "deploy":
      return `deploy ${action.environment ?? "(default)"}`;
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
    case "feature_file":
      return { path: action.path, contentBytes: action.content.length };
    case "cucumber":
      return { path: action.path ?? null };
    case "deploy":
      return { environment: action.environment ?? null };
    case "done":
      return { summary: action.summary };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n... [truncated]` : s;
}

/**
 * Endless-mode plan signature. Same shape as `drive.ts:planSignature`
 * but extended for the new tools so the breaker can detect repeats
 * across them too.
 *
 * Exported so tests can pin the format.
 */
export function planSignatureV2(action: PlanAction): string {
  switch (action.tool) {
    case "read_file":
      return `read_file::${action.path}`;
    case "write_file":
      return `write_file::${action.path}::${action.content.length}::${
        action.content.slice(0, 64)
      }::${action.content.slice(-64)}`;
    case "exec":
      return `exec::${action.command.replace(/\s+/g, " ").trim()}`;
    case "feature_file":
      return `feature_file::${action.path}::${action.content.length}::${
        action.content.slice(0, 64)
      }::${action.content.slice(-64)}`;
    case "cucumber":
      return `cucumber::${action.path ?? ""}`;
    case "deploy":
      return `deploy::${action.environment ?? ""}`;
    case "done":
      return `done::${action.summary.trim()}`;
  }
}
