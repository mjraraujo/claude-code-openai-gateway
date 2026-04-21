/**
 * Department cron scheduler.
 *
 * Runs as a singleton minute-resolution ticker. On each tick it
 * inspects every department's cron entries; any that are due and not
 * already running are dispatched to a small per-job execution loop
 * (a one-shot variant of the auto-drive engine, capped tightly to
 * keep cost bounded).
 *
 * Schedule grammar (kept intentionally tiny):
 *   - "every 5m", "every 15m", "every 1h"
 *   - "@hourly", "@daily"
 *
 * Anything else is ignored — the cron just won't fire — so an unknown
 * schedule string is harmless.
 */

import {
  execCommand,
  readFile,
  runCucumber,
  runDeploy,
  writeFeatureFile,
  writeFile,
} from "./tools";
import { plan } from "./planner";
import {
  AutoDriveStep,
  CronJob,
  Department,
  getStore,
} from "./store";

const TICK_MS = 60_000;
const PER_JOB_MAX_STEPS = 6;
const PER_JOB_MAX_WALL_MS = 90_000;

let started = false;
const inflight = new Set<string>(); // cron-job ids currently running

export function startCronOnce(): void {
  if (started) return;
  started = true;
  // First tick in 30s so we don't slam the gateway on cold start.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), TICK_MS);
  }, 30_000);
}

async function tick(): Promise<void> {
  const snap = await getStore().snapshot();
  const now = Date.now();
  for (const dept of snap.departments) {
    for (const job of dept.cron) {
      if (inflight.has(job.id)) continue;
      if (!isDue(job, now)) continue;
      inflight.add(job.id);
      runJob(dept, job).finally(() => inflight.delete(job.id));
    }
  }
}

function isDue(job: CronJob, now: number): boolean {
  const intervalMs = parseSchedule(job.schedule);
  if (intervalMs == null) return false;
  if (!job.lastRunAt) return true;
  return now - job.lastRunAt >= intervalMs;
}

export function parseSchedule(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (s === "@hourly") return 60 * 60 * 1000;
  if (s === "@daily") return 24 * 60 * 60 * 1000;
  const match = s.match(/^every\s+(\d+)\s*(m|h)$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return match[2] === "h" ? n * 60 * 60 * 1000 : n * 60 * 1000;
}

async function runJob(dept: Department, job: CronJob): Promise<void> {
  const startedAt = Date.now();
  const steps: AutoDriveStep[] = [];
  let status: "ok" | "error" = "ok";
  let summary = "no-op";
  const maxSteps = Math.min(job.maxSteps, PER_JOB_MAX_STEPS);
  // Read the persisted model once at job start so changes mid-run are
  // ignored (more predictable for users tweaking the dropdown).
  const snap = await getStore().snapshot();
  const model = snap.harness.model;

  try {
    for (let i = 0; i < maxSteps; i++) {
      if (Date.now() - startedAt > PER_JOB_MAX_WALL_MS) {
        summary = "wall-time exceeded";
        break;
      }
      const p = await plan({
        goal: `[${dept.name} cron] ${job.prompt}`,
        steps,
        maxStepsRemaining: maxSteps - i,
        model,
      });
      steps.push({
        index: steps.length,
        at: Date.now(),
        kind: "plan",
        text: p.thought,
        data: { tool: p.action.tool },
      });
      if (p.action.tool === "done") {
        summary = p.action.summary || "done";
        break;
      }
      let result;
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
        case "feature_file":
          result = await writeFeatureFile(p.action.path, p.action.content);
          break;
        case "cucumber":
          result = await runCucumber(p.action.path);
          break;
        case "deploy":
          result = await runDeploy(p.action.environment);
          break;
      }
      steps.push({
        index: steps.length,
        at: Date.now(),
        kind: "tool_result",
        text: result.ok ? "ok" : `err: ${result.error ?? ""}`,
      });
    }
  } catch (err) {
    status = "error";
    summary = (err as Error).message;
  }

  await getStore().update((draft) => {
    const d = draft.departments.find((x) => x.id === dept.id);
    const j = d?.cron.find((x) => x.id === job.id);
    if (!j) return;
    j.lastRunAt = Date.now();
    j.lastRunStatus = status;
    j.lastRunSummary = summary.slice(0, 200);
  });
}
