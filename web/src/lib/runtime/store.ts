/**
 * Runtime state persistence.
 *
 * The Mission Control "runtime" is the in-process orchestrator that
 * tracks harness flags, departments, cron jobs, and auto-drive runs.
 * State lives in a single JSON file under `~/.codex-gateway/` so it
 * survives `next dev` HMR reloads (the singleton in-memory copy is
 * rehydrated on first read) and so the CLI gateway can inspect it
 * later if we expose it there.
 *
 * Mutations go through `update()` which:
 *   1. mutates the singleton in memory
 *   2. emits a `change` event (consumed by the SSE state route)
 *   3. queues an atomic write-rename to disk
 *
 * The change emitter is a plain `EventEmitter` from node:events; the
 * SSE route subscribes per-request and unsubscribes on disconnect.
 */

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { readEnv } from "@/lib/env";

import type { SdlcState } from "./sdlc";
import { INITIAL_SDLC_STATE } from "./sdlc";

// Re-exported for convenience so drive-v2 / route handlers don't
// have to dual-import from store + sdlc.
export { INITIAL_SDLC_STATE };
export type { SdlcState };

export type AgentStatus = "active" | "idle" | "blocked";

export interface AgentState {
  id: string;
  name: string;
  status: AgentStatus;
  skill: string;
  /**
   * Optional grouping for the Agents panel sidebar filter. Free-
   * form so departments don't have to be pre-declared in
   * `RuntimeState.departments`. When set, the panel offers a
   * "filter by department" affordance.
   */
  department?: string;
  /**
   * Optional per-agent model override. When unset the agent uses
   * the global `HarnessState.model`. Same id-shape constraints as
   * the global field; validated by `/api/runtime/agents`.
   */
  model?: string;
}

/**
 * Identifier for the active "ruflo" persona. Each persona has a
 * distinct system-prompt fragment and lights up a different agent
 * row in the Agents panel during an auto-drive run.
 */
export type RufloPersona = "core" | "impl" | "review";

/**
 * Auto-drive operating mode.
 *
 *   - "bounded"  — original behaviour: hard caps on steps, wall-time,
 *     and bytes. Safe default for one-shot tasks invoked from a Kanban
 *     card or from the Engage modal.
 *   - "endless"  — the v2 "deliver until done" mode: removes the
 *     step/wall/byte caps, walks an SDLC state machine, and only
 *     terminates when every gate is green or the operator hits the
 *     kill switch. The circuit breaker is still in effect with
 *     larger thresholds.
 */
export type DriveMode = "bounded" | "endless";

export const VALID_DRIVE_MODES: readonly DriveMode[] = ["bounded", "endless"];

export function isValidDriveMode(value: unknown): value is DriveMode {
  return value === "bounded" || value === "endless";
}

export interface HarnessState {
  autoApproveSafeEdits: boolean;
  streamToolOutput: boolean;
  persistContext: boolean;
  /**
   * Model id used for planner / cron / auto-drive requests routed
   * through the local gateway. Free-form string — the gateway maps it
   * to a backend route.
   */
  model: string;
  /**
   * Planning style hints surfaced to the auto-drive planner system
   * prompt. Driven by the Kanban panel selectors so the operator's
   * choice actually changes how the loop plans, not just how it's
   * labelled in the UI. Both default to empty (no hint).
   */
  methodology?: string;
  devMode?: string;
  /**
   * Active ruflo persona — fed to the planner system prompt and
   * mirrored as the "active" agent row during a drive. Defaults to
   * "core".
   */
  persona: RufloPersona;
  /**
   * Default auto-drive mode used when the operator engages without
   * an explicit override. Defaults to "bounded" so existing flows
   * keep their safety rails; opt into "endless" for deliver-until-done.
   */
  driveMode: DriveMode;
}

export const VALID_PERSONAS: readonly RufloPersona[] = ["core", "impl", "review"];

/** Pure type guard, used by the harness PATCH handler and tests. */
export function isValidPersona(value: unknown): value is RufloPersona {
  return value === "core" || value === "impl" || value === "review";
}

/** Maps a persona id to the seeded agent row that should light up. */
export function personaAgentId(persona: RufloPersona): string {
  switch (persona) {
    case "core":
      return "ruflo-core";
    case "impl":
      return "ruflo-impl";
    case "review":
      return "ruflo-review";
  }
}

export const DEFAULT_MODEL = "gpt-5.3-codex";

export interface CronJob {
  id: string;
  /** Free-form schedule string. Currently supports "every Nm" / "every Nh" / "@hourly" / "@daily". */
  schedule: string;
  prompt: string;
  /** Per-run step cap. */
  maxSteps: number;
  lastRunAt?: number;
  lastRunStatus?: "ok" | "error" | "skipped";
  lastRunSummary?: string;
}

export interface Department {
  id: string;
  name: string;
  cron: CronJob[];
}

export type TaskColumn = "backlog" | "active" | "review" | "shipped";

export interface SubTask {
  id: string;
  title: string;
  done: boolean;
}

/**
 * Single recorded message in a Three Amigos transcript persisted on
 * a Task. Bounded by `MAX_TRANSCRIPT_ENTRIES_PER_TASK` /
 * `MAX_TRANSCRIPT_MESSAGE_CHARS` so the on-disk JSON stays small.
 */
export type AmigosTranscriptKind =
  | "agent_thinking"
  | "agent_message"
  | "consensus"
  | "gherkin_draft"
  | "done"
  | "error";

export interface AmigosTranscriptEntry {
  at: number;
  kind: AmigosTranscriptKind;
  /** Persona id for `agent_*` entries — one of "business" | "dev" | "qa" by convention. */
  persona?: string;
  /** Free-form payload (message body, gherkin text, error reason, …). */
  text: string;
}

export interface Task {
  id: string;
  title: string;
  column: TaskColumn;
  tag?: string;
  createdAt: number;
  /** Id of an auto-drive run triggered from this task, if any. */
  runId?: string;
  /** Optional checklist of sub-items. Empty or omitted = no checklist. */
  subtasks?: SubTask[];
  /** Workspace this card belongs to. Falls back to the active workspace when absent. */
  workspaceId?: string;
  /** ISO-8601 due date (date or full datetime). Validated client-side and on the route. */
  dueDate?: string;
  /** Free-form list of assignee identifiers (agent ids or human handles). Capped at 8. */
  assignees?: string[];
  /** Optional sprint association. */
  sprintId?: string;
  /** Path (relative to the workspace) of the .feature file emitted by Three Amigos for this card. */
  featurePath?: string;
  /** Bounded transcript of the most recent Three Amigos refinement run. */
  amigosTranscript?: AmigosTranscriptEntry[];
}

/**
 * A user-visible workspace. The `root` is an absolute filesystem path
 * the dashboard's fs/exec tools resolve against. Multiple workspaces
 * let one dashboard switch between projects without restarting.
 */
export interface Workspace {
  id: string;
  name: string;
  root: string;
  createdAt: number;
}

/** A lightweight sprint/iteration that tasks can be associated with. */
export interface Sprint {
  id: string;
  name: string;
  /** ISO-8601 start date. */
  startsAt?: string;
  /** ISO-8601 end date. */
  endsAt?: string;
}

/**
 * Per-workspace scaffolding ledger. Records which methodology /
 * devMode templates have been materialised so seeding stays
 * idempotent across harness changes and process restarts.
 */
export interface ScaffoldRecord {
  workspaceId: string;
  methodology?: string;
  devMode?: string;
  agentsSeeded?: boolean;
  filesSeeded?: string[];
}

export type AutoDriveStepKind =
  | "plan"
  | "tool"
  | "tool_result"
  | "info"
  | "error";

export interface AutoDriveStep {
  index: number;
  at: number;
  kind: AutoDriveStepKind;
  text: string;
  /** Optional structured payload (tool name, args, etc.). */
  data?: Record<string, unknown>;
}

export type AutoDriveStatus =
  | "idle"
  | "running"
  | "completed"
  | "stopped"
  | "error";

export interface AutoDriveRun {
  id: string;
  goal: string;
  startedAt: number;
  endedAt?: number;
  status: AutoDriveStatus;
  steps: AutoDriveStep[];
  /** Cumulative tool-output bytes — used as a coarse cost proxy. */
  bytesEmitted: number;
  /** Reason for ending (only set on terminal states). */
  reason?: string;
  /**
   * Drive mode this run was started under. Surfaced to the UI so the
   * SDLC progress bar and "endless" indicator render correctly.
   * Optional for backward-compat with runs persisted before v2.
   */
  mode?: DriveMode;
  /**
   * SDLC state machine snapshot. Present iff `mode === "endless"`.
   */
  sdlc?: SdlcState;
}

/**
 * Snapshot of the most recent Three Amigos run, persisted on the
 * runtime so the dashboard can rehydrate findings after a refresh
 * without re-running the whole pass. Bounded by `normalizeAmigosReport`
 * to keep `claude-codex.json` small.
 *
 * Mirrors the shape produced by `runAmigos()` in `./amigos.ts` —
 * we don't import the type here to avoid a circular dep, since
 * `amigos.ts` imports `DEFAULT_MODEL` from this module.
 */
export interface PersistedAmigoFinding {
  persona: "business" | "dev" | "qa";
  severity: "blocker" | "concern" | "info";
  message: string;
}
export interface PersistedAmigoResult {
  persona: "business" | "dev" | "qa";
  ok: boolean;
  summary: string;
  findings: PersistedAmigoFinding[];
  error?: string;
}
export interface PersistedScenarioReport {
  featurePath: string;
  scenarioId: string;
  scenarioName: string;
  verdict: "pass" | "concerns" | "fail";
  findings: PersistedAmigoFinding[];
  amigos: PersistedAmigoResult[];
}
export interface PersistedAmigosReport {
  startedAt: number;
  endedAt?: number;
  scope:
    | { type: "all" }
    | { type: "feature"; path: string }
    | { type: "scenario"; path: string; scenarioId: string };
  total: number;
  scanned: number;
  pass: number;
  concerns: number;
  fail: number;
  scenarios: PersistedScenarioReport[];
  error?: string;
}

export interface RuntimeState {
  agents: AgentState[];
  harness: HarnessState;
  departments: Department[];
  tasks: Task[];
  /** Configured workspaces. Always non-empty after `ensureLoaded()`. */
  workspaces: Workspace[];
  /** Id of the workspace currently in focus. */
  activeWorkspaceId: string;
  /** Sprints (light-weight iterations) cards can be attached to. */
  sprints: Sprint[];
  /** Per-workspace scaffolding ledger; tracks methodology/devMode seeding. */
  scaffolds: ScaffoldRecord[];
  autoDrive: {
    /** The active run, if any. */
    current: AutoDriveRun | null;
    /** Last 10 finished runs, newest first. */
    history: AutoDriveRun[];
  };
  /** Last Three Amigos report, if any. */
  amigosReport?: PersistedAmigosReport;
}

const CONFIG_DIR = path.join(
  process.env.CODEX_GATEWAY_CONFIG_DIR || os.homedir() || ".",
  ".codex-gateway",
);
const STATE_FILE = path.join(CONFIG_DIR, "claude-codex.json");
/** Legacy on-disk filename from the "Mission Control" era. Migrated
 * in-place on first load if the new file doesn't exist yet. */
const LEGACY_STATE_FILE = path.join(CONFIG_DIR, "mission-control.json");

const SEED_TASKS: Task[] = [
  { id: "T-101", title: "Wire OAuth device flow to gateway", column: "shipped", tag: "auth", createdAt: 0 },
  { id: "T-102", title: "Claude Codex 3-panel shell", column: "shipped", tag: "ui", createdAt: 0 },
  { id: "T-103", title: "Embed Monaco workspace tab", column: "shipped", tag: "editor", createdAt: 0 },
  { id: "T-104", title: "Real PTY for in-browser terminal", column: "shipped", tag: "infra", createdAt: 0 },
  { id: "T-105", title: "Departments + cron matrix", column: "shipped", tag: "ops", createdAt: 0 },
  { id: "T-106", title: "Full Auto Drive safety rails", column: "shipped", tag: "safety", createdAt: 0 },
];

/**
 * Default workspace root resolution. Honours the same env vars as
 * `@/lib/fs/workspace` so the seed workspace registers a directory
 * the existing `safeJoin` already knows about. Falls back to the
 * parent of `process.cwd()` (the gateway repo root when running
 * from `web/`) so first-run dashboards are immediately useful.
 */
export const DEFAULT_WORKSPACE_ROOT = path.resolve(
  readEnv("CLAUDE_CODEX_WORKSPACE", "MISSION_CONTROL_WORKSPACE") ||
    path.join(process.cwd(), ".."),
);

/**
 * Parent directory under which "+ New workspace" creates fresh
 * project directories. Operators can override via env so a Docker
 * deployment can mount a host folder that holds many workspaces.
 */
export const WORKSPACES_PARENT_DIR = path.resolve(
  readEnv("CLAUDE_CODEX_WORKSPACES_DIR", "MISSION_CONTROL_WORKSPACES_DIR") ||
    path.join(os.homedir() || ".", "codex-workspaces"),
);

const DEFAULT_WORKSPACE_ID = "default";

const DEFAULT_STATE: RuntimeState = {
  agents: [
    { id: "ruflo-core", name: "ruflo · core", status: "idle", skill: "—" },
    { id: "ruflo-impl", name: "ruflo · impl", status: "idle", skill: "—" },
    { id: "ruflo-review", name: "ruflo · review", status: "idle", skill: "—" },
    { id: "harness", name: "harness", status: "idle", skill: "—" },
  ],
  harness: {
    autoApproveSafeEdits: true,
    streamToolOutput: true,
    persistContext: false,
    model: DEFAULT_MODEL,
    methodology: "Shape Up",
    devMode: "Spec Driven",
    persona: "core",
    driveMode: "bounded",
  },
  departments: [
    { id: "engineering", name: "Engineering", cron: [] },
    { id: "product", name: "Product", cron: [] },
    { id: "ops", name: "Ops", cron: [] },
  ],
  tasks: SEED_TASKS,
  workspaces: [
    {
      id: DEFAULT_WORKSPACE_ID,
      name: "default",
      root: DEFAULT_WORKSPACE_ROOT,
      createdAt: 0,
    },
  ],
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  sprints: [],
  scaffolds: [],
  autoDrive: { current: null, history: [] },
};

class RuntimeStore extends EventEmitter {
  private state: RuntimeState = structuredClone(DEFAULT_STATE);
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(STATE_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<RuntimeState>;
      this.state = mergeWithDefaults(parsed);
    } catch {
      // New state file not found — try the legacy filename from the
      // "Mission Control" era. If present, rehydrate from it and
      // rename it to the new name so subsequent boots go the fast
      // path. Best-effort: a failed rename still works in-memory and
      // the next `persist()` will write to the new filename.
      try {
        const legacyRaw = await fs.readFile(LEGACY_STATE_FILE, "utf8");
        const parsed = JSON.parse(legacyRaw) as Partial<RuntimeState>;
        this.state = mergeWithDefaults(parsed);
        try {
          await fs.rename(LEGACY_STATE_FILE, STATE_FILE);
        } catch {
          // Rename failed (EXDEV, perms, etc.) — leave legacy file
          // alone; `persist()` will write the new file shortly.
        }
      } catch {
        // Neither file present / readable — keep defaults.
      }
    }
  }

  /** Returns a structured-clone of state — callers cannot mutate it. */
  async snapshot(): Promise<RuntimeState> {
    await this.ensureLoaded();
    return structuredClone(this.state);
  }

  /**
   * Mutate state through a callback. The callback receives a mutable
   * draft; the result is persisted and a `change` event is fired.
   */
  async update(mutator: (draft: RuntimeState) => void): Promise<RuntimeState> {
    await this.ensureLoaded();
    mutator(this.state);
    this.persist();
    const snap = structuredClone(this.state);
    this.emit("change", snap);
    return snap;
  }

  private persist(): void {
    const snap = structuredClone(this.state);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => writeStateAtomic(snap));
  }
}

let store: RuntimeStore | null = null;

export function getStore(): RuntimeStore {
  if (!store) {
    store = new RuntimeStore();
    // Allow many concurrent SSE listeners.
    store.setMaxListeners(0);
  }
  return store;
}

async function writeStateAtomic(state: RuntimeState): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const tmp = STATE_FILE + ".tmp-" + crypto.randomBytes(4).toString("hex");
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, STATE_FILE);
  } catch {
    // Best-effort persistence; in-memory state is still authoritative.
  }
}

function mergeWithDefaults(parsed: Partial<RuntimeState>): RuntimeState {
  const merged = structuredClone(DEFAULT_STATE);
  if (parsed.agents && Array.isArray(parsed.agents)) {
    merged.agents = parsed.agents
      .map((a) => normalizeAgent(a))
      .filter((a): a is AgentState => a !== null);
  }
  if (parsed.harness) {
    merged.harness = { ...merged.harness, ...parsed.harness };
    if (typeof parsed.harness.model !== "string" || !parsed.harness.model.trim()) {
      merged.harness.model = DEFAULT_MODEL;
    }
    // Persona: validate against the closed set or fall back to "core".
    merged.harness.persona = isValidPersona(parsed.harness.persona)
      ? parsed.harness.persona
      : "core";
    // Drive mode: validate against the closed set or default to "bounded".
    merged.harness.driveMode = isValidDriveMode(parsed.harness.driveMode)
      ? parsed.harness.driveMode
      : "bounded";
  }
  if (parsed.departments && Array.isArray(parsed.departments)) {
    merged.departments = parsed.departments.map((d) => ({
      id: String(d.id),
      name: String(d.name),
      cron: Array.isArray(d.cron) ? d.cron : [],
    }));
  }
  if (parsed.autoDrive) {
    merged.autoDrive = {
      // Never restore "running" status from disk — a previous process
      // crash should not leave an orphan run reported as live.
      current: null,
      history: Array.isArray(parsed.autoDrive.history)
        ? parsed.autoDrive.history.slice(0, 10)
        : [],
    };
  }
  if (parsed.tasks && Array.isArray(parsed.tasks)) {
    merged.tasks = parsed.tasks.map((t) => ({
      id: String(t.id),
      title: String(t.title),
      column: (["backlog", "active", "review", "shipped"].includes(String(t.column))
        ? t.column
        : "backlog") as TaskColumn,
      tag: typeof t.tag === "string" ? t.tag : undefined,
      createdAt: typeof t.createdAt === "number" ? t.createdAt : 0,
      runId: typeof t.runId === "string" ? t.runId : undefined,
      subtasks: normalizeSubtasks((t as { subtasks?: unknown }).subtasks),
      workspaceId: normalizeOptionalId((t as { workspaceId?: unknown }).workspaceId),
      dueDate: normalizeIsoDate((t as { dueDate?: unknown }).dueDate),
      assignees: normalizeAssignees((t as { assignees?: unknown }).assignees),
      sprintId: normalizeOptionalId((t as { sprintId?: unknown }).sprintId),
      featurePath: normalizeOptionalRelPath(
        (t as { featurePath?: unknown }).featurePath,
      ),
      amigosTranscript: normalizeAmigosTranscript(
        (t as { amigosTranscript?: unknown }).amigosTranscript,
      ),
    }));
  }
  // Workspaces — keep at least the default entry so consumers can
  // assume `state.workspaces.length >= 1`.
  if (parsed.workspaces && Array.isArray(parsed.workspaces)) {
    const ws: Workspace[] = [];
    for (const raw of parsed.workspaces) {
      const norm = normalizeWorkspace(raw);
      if (norm) ws.push(norm);
    }
    if (ws.length > 0) merged.workspaces = ws;
  }
  if (typeof parsed.activeWorkspaceId === "string" && parsed.activeWorkspaceId) {
    if (merged.workspaces.some((w) => w.id === parsed.activeWorkspaceId)) {
      merged.activeWorkspaceId = parsed.activeWorkspaceId;
    }
  }
  if (parsed.sprints && Array.isArray(parsed.sprints)) {
    merged.sprints = [];
    for (const raw of parsed.sprints) {
      const norm = normalizeSprint(raw);
      if (norm) merged.sprints.push(norm);
    }
  }
  if (parsed.scaffolds && Array.isArray(parsed.scaffolds)) {
    merged.scaffolds = [];
    for (const raw of parsed.scaffolds) {
      const norm = normalizeScaffold(raw);
      if (norm) merged.scaffolds.push(norm);
    }
  }
  const reportRaw = (parsed as { amigosReport?: unknown }).amigosReport;
  const report = normalizeAmigosReport(reportRaw);
  if (report) merged.amigosReport = report;
  return merged;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("base64url")}`;
}

/** Max length for a sub-task title, matched by the POST/PATCH tasks route. */
export const MAX_SUBTASK_TITLE_LENGTH = 200;
/** Max number of sub-tasks per card. Prevents unbounded growth. */
export const MAX_SUBTASKS_PER_TASK = 50;

/* ─── Three Amigos persisted-report bounds ─────────────────────────── */
/** Max scenarios stored on disk. Older entries beyond this are dropped. */
export const MAX_AMIGOS_SCENARIOS_PERSISTED = 200;
/** Max findings per scenario kept on disk. */
export const MAX_AMIGOS_FINDINGS_PER_SCENARIO = 30;
/** Max chars per finding message kept on disk. */
export const MAX_AMIGOS_FINDING_CHARS = 600;
/** Max chars for a free-form summary string kept on disk. */
export const MAX_AMIGOS_SUMMARY_CHARS = 600;

const AMIGO_PERSONA_SET = new Set(["business", "dev", "qa"]);
const AMIGO_SEVERITY_SET = new Set(["blocker", "concern", "info"]);
const AMIGO_VERDICT_SET = new Set(["pass", "concerns", "fail"]);

/**
 * Coerce a deserialized `amigosReport` value into a bounded shape.
 * Unknown / malformed input becomes `undefined` so the round-trip
 * stays honest (no half-built reports). Caps array sizes and
 * truncates long strings so the on-disk JSON stays small even after
 * many runs.
 */
export function normalizeAmigosReport(
  raw: unknown,
): PersistedAmigosReport | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const startedAt = typeof r.startedAt === "number" ? r.startedAt : null;
  if (startedAt === null) return undefined;
  const scope = normalizeAmigosScope(r.scope);
  if (!scope) return undefined;
  const scenariosRaw = Array.isArray(r.scenarios) ? r.scenarios : [];
  const scenarios: PersistedScenarioReport[] = [];
  for (const s of scenariosRaw) {
    if (scenarios.length >= MAX_AMIGOS_SCENARIOS_PERSISTED) break;
    const norm = normalizeScenarioReport(s);
    if (norm) scenarios.push(norm);
  }
  return {
    startedAt,
    endedAt: typeof r.endedAt === "number" ? r.endedAt : undefined,
    scope,
    total: clampInt32(r.total),
    scanned: clampInt32(r.scanned),
    pass: clampInt32(r.pass),
    concerns: clampInt32(r.concerns),
    fail: clampInt32(r.fail),
    scenarios,
    error: typeof r.error === "string" ? r.error.slice(0, 400) : undefined,
  };
}

function normalizeAmigosScope(
  raw: unknown,
): PersistedAmigosReport["scope"] | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.type === "all") return { type: "all" };
  if (s.type === "feature" && typeof s.path === "string") {
    return { type: "feature", path: s.path.slice(0, 1024) };
  }
  if (
    s.type === "scenario" &&
    typeof s.path === "string" &&
    typeof s.scenarioId === "string"
  ) {
    return {
      type: "scenario",
      path: s.path.slice(0, 1024),
      scenarioId: s.scenarioId.slice(0, 200),
    };
  }
  return null;
}

function normalizeScenarioReport(raw: unknown): PersistedScenarioReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const featurePath = typeof r.featurePath === "string" ? r.featurePath.slice(0, 1024) : "";
  const scenarioId = typeof r.scenarioId === "string" ? r.scenarioId.slice(0, 200) : "";
  const scenarioName = typeof r.scenarioName === "string" ? r.scenarioName.slice(0, 400) : "";
  if (!featurePath || !scenarioId) return null;
  const verdict = AMIGO_VERDICT_SET.has(r.verdict as string)
    ? (r.verdict as PersistedScenarioReport["verdict"])
    : "concerns";
  const findings: PersistedAmigoFinding[] = [];
  if (Array.isArray(r.findings)) {
    for (const f of r.findings) {
      if (findings.length >= MAX_AMIGOS_FINDINGS_PER_SCENARIO) break;
      const norm = normalizeAmigoFinding(f);
      if (norm) findings.push(norm);
    }
  }
  const amigos: PersistedAmigoResult[] = [];
  if (Array.isArray(r.amigos)) {
    for (const a of r.amigos) {
      if (amigos.length >= 3) break;
      const norm = normalizeAmigoResult(a);
      if (norm) amigos.push(norm);
    }
  }
  return { featurePath, scenarioId, scenarioName, verdict, findings, amigos };
}

function normalizeAmigoFinding(raw: unknown): PersistedAmigoFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!AMIGO_PERSONA_SET.has(r.persona as string)) return null;
  if (!AMIGO_SEVERITY_SET.has(r.severity as string)) return null;
  const message = typeof r.message === "string" ? r.message.trim() : "";
  if (!message) return null;
  return {
    persona: r.persona as PersistedAmigoFinding["persona"],
    severity: r.severity as PersistedAmigoFinding["severity"],
    message: message.slice(0, MAX_AMIGOS_FINDING_CHARS),
  };
}

function normalizeAmigoResult(raw: unknown): PersistedAmigoResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!AMIGO_PERSONA_SET.has(r.persona as string)) return null;
  const findings: PersistedAmigoFinding[] = [];
  if (Array.isArray(r.findings)) {
    for (const f of r.findings) {
      if (findings.length >= MAX_AMIGOS_FINDINGS_PER_SCENARIO) break;
      const norm = normalizeAmigoFinding(f);
      if (norm) findings.push(norm);
    }
  }
  return {
    persona: r.persona as PersistedAmigoResult["persona"],
    ok: r.ok === true,
    summary: typeof r.summary === "string" ? r.summary.slice(0, MAX_AMIGOS_SUMMARY_CHARS) : "",
    findings,
    error: typeof r.error === "string" ? r.error.slice(0, 400) : undefined,
  };
}

function clampInt32(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(0x7fffffff, Math.floor(raw)));
}

/**
 * Coerce a deserialized value into a `SubTask[]`. Unknown / malformed
 * input becomes `undefined` so the property round-trips as "no
 * checklist" rather than an empty array (keeps JSON small).
 */
export function normalizeSubtasks(raw: unknown): SubTask[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SubTask[] = [];
  for (const item of raw) {
    if (out.length >= MAX_SUBTASKS_PER_TASK) break;
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" && r.id ? r.id : null;
    const title =
      typeof r.title === "string"
        ? r.title.trim().slice(0, MAX_SUBTASK_TITLE_LENGTH)
        : "";
    if (!id || !title) continue;
    out.push({ id, title, done: r.done === true });
  }
  return out.length > 0 ? out : undefined;
}

/** Bounds for the persisted Three Amigos transcript on a Task. */
export const MAX_TRANSCRIPT_ENTRIES_PER_TASK = 200;
export const MAX_TRANSCRIPT_MESSAGE_CHARS = 2000;
/** Cap on assignees per card. Wide enough for a real team, narrow enough to keep payloads small. */
export const MAX_ASSIGNEES_PER_TASK = 8;
/** Cap on the per-assignee identifier length. */
export const MAX_ASSIGNEE_LENGTH = 80;
/** Cap on workspaces per dashboard. Soft limit to avoid runaway state. */
export const MAX_WORKSPACES = 32;
/** Cap on a workspace name. */
export const MAX_WORKSPACE_NAME = 64;
/** Cap on a sprint name. */
export const MAX_SPRINT_NAME = 80;

const TRANSCRIPT_KIND_SET = new Set<AmigosTranscriptKind>([
  "agent_thinking",
  "agent_message",
  "consensus",
  "gherkin_draft",
  "done",
  "error",
]);

/**
 * Coerce a deserialized value into a `Workspace` or null. The `root`
 * is required and must be an absolute path so the dashboard's path
 * sanitizer has something concrete to anchor against.
 */
export function normalizeWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && /^[\w.\-]{1,64}$/.test(r.id) ? r.id : null;
  const name =
    typeof r.name === "string" && r.name.trim()
      ? r.name.trim().slice(0, MAX_WORKSPACE_NAME)
      : null;
  const root =
    typeof r.root === "string" && path.isAbsolute(r.root)
      ? path.resolve(r.root)
      : null;
  if (!id || !name || !root) return null;
  return {
    id,
    name,
    root,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
  };
}

/** Coerce a deserialized value into a `Sprint` or null. */
export function normalizeSprint(raw: unknown): Sprint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id ? r.id : null;
  const name =
    typeof r.name === "string" && r.name.trim()
      ? r.name.trim().slice(0, MAX_SPRINT_NAME)
      : null;
  if (!id || !name) return null;
  return {
    id,
    name,
    startsAt: normalizeIsoDate(r.startsAt),
    endsAt: normalizeIsoDate(r.endsAt),
  };
}

/** Coerce a deserialized value into a `ScaffoldRecord` or null. */
function normalizeScaffold(raw: unknown): ScaffoldRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const workspaceId = typeof r.workspaceId === "string" && r.workspaceId ? r.workspaceId : null;
  if (!workspaceId) return null;
  const filesSeeded = Array.isArray(r.filesSeeded)
    ? r.filesSeeded.filter((x): x is string => typeof x === "string").slice(0, 200)
    : undefined;
  return {
    workspaceId,
    methodology:
      typeof r.methodology === "string" ? r.methodology.slice(0, 64) : undefined,
    devMode: typeof r.devMode === "string" ? r.devMode.slice(0, 64) : undefined,
    agentsSeeded: r.agentsSeeded === true ? true : undefined,
    filesSeeded,
  };
}

function normalizeOptionalId(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  // Same shape as workspace / sprint ids; constrains but doesn't
  // reject runtime-generated `T_xxx` style ids.
  if (!/^[\w.\-]{1,64}$/.test(raw)) return undefined;
  return raw;
}

function normalizeOptionalRelPath(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  // Reject absolute paths and parent traversal — featurePath is a
  // workspace-relative POSIX path stored only for UI linkage.
  const cleaned = raw.replace(/\\/g, "/").trim();
  if (!cleaned || cleaned.startsWith("/")) return undefined;
  if (cleaned.split("/").some((seg) => seg === "..")) return undefined;
  return cleaned.slice(0, 1024);
}

/**
 * Validate an ISO-8601 date or datetime string. Returns the
 * canonicalised string or undefined. Trailing whitespace and case
 * are normalised; we use Date.parse as the authoritative validator
 * (rejects garbage like "tomorrow" or "2026-13-99").
 */
export function normalizeIsoDate(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  // Cap so malicious clients can't store giant blobs in the field.
  if (s.length > 40) return undefined;
  const parsed = Date.parse(s);
  if (!Number.isFinite(parsed)) return undefined;
  return s;
}

/**
 * Coerce a deserialized value into a sanitised assignees array, or
 * undefined when there are no valid entries. Each entry is a
 * non-empty string capped at MAX_ASSIGNEE_LENGTH; duplicates are
 * collapsed; the array is capped at MAX_ASSIGNEES_PER_TASK.
 */
export function normalizeAssignees(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    // Allow letters, digits, and a few common punctuation chars seen
    // in user handles / agent ids. Strip control characters and
    // anything that would make the value unsafe to render verbatim.
    // eslint-disable-next-line no-control-regex
    const cleaned = item.replace(/[\x00-\x1f\x7f<>`]/g, "").trim();
    if (!cleaned) continue;
    const capped = cleaned.slice(0, MAX_ASSIGNEE_LENGTH);
    if (seen.has(capped)) continue;
    seen.add(capped);
    out.push(capped);
    if (out.length >= MAX_ASSIGNEES_PER_TASK) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Coerce a deserialized value into a sanitised Three Amigos
 * transcript, or undefined. Bounded to keep on-disk JSON small.
 */
export function normalizeAmigosTranscript(
  raw: unknown,
): AmigosTranscriptEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AmigosTranscriptEntry[] = [];
  for (const item of raw) {
    if (out.length >= MAX_TRANSCRIPT_ENTRIES_PER_TASK) break;
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (!TRANSCRIPT_KIND_SET.has(r.kind as AmigosTranscriptKind)) continue;
    const text = typeof r.text === "string" ? r.text : "";
    if (!text) continue;
    out.push({
      at: typeof r.at === "number" ? r.at : Date.now(),
      kind: r.kind as AmigosTranscriptKind,
      persona:
        typeof r.persona === "string" && r.persona
          ? r.persona.slice(0, 32)
          : undefined,
      text: text.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Convenience: locate the active workspace, never returning null. */
export function activeWorkspace(state: RuntimeState): Workspace {
  const found = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (found) return found;
  // Fallback: if the active id became stale (workspace deleted),
  // fall back to the first entry; callers will see a coherent root.
  return state.workspaces[0];
}

/**
 * Coerce an arbitrary deserialized value into an `AgentState`.
 * Returns null if the input lacks the required `id` / `name` fields
 * so callers can drop bad records instead of corrupting the store.
 *
 * Optional fields (`department`, `model`) are only kept when they
 * pass simple validation; everything else falls back to defaults.
 */
function normalizeAgent(raw: unknown): AgentState | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const id = typeof a.id === "string" && a.id ? a.id : null;
  const name = typeof a.name === "string" && a.name ? a.name : null;
  if (!id || !name) return null;
  const status: AgentStatus =
    a.status === "active" || a.status === "idle" || a.status === "blocked"
      ? a.status
      : "idle";
  const skill = typeof a.skill === "string" && a.skill ? a.skill : "—";
  const dept = typeof a.department === "string" ? a.department.trim() : "";
  const model = typeof a.model === "string" ? a.model.trim() : "";
  return {
    id,
    name,
    status,
    skill,
    department: dept || undefined,
    model: isValidModelId(model) ? model : undefined,
  };
}

/**
 * Same regex/length constraints as `/api/runtime/harness` applies
 * to `harness.model`. Centralised here so per-agent overrides can't
 * diverge from the global validation surface.
 */
export function isValidModelId(value: string): boolean {
  if (!value) return false;
  if (value.length > 64) return false;
  return /^[\w.\-:/]+$/.test(value);
}
