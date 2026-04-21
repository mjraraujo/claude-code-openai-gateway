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
}

export const DEFAULT_MODEL = "gpt-5.4";

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

export interface Task {
  id: string;
  title: string;
  column: TaskColumn;
  tag?: string;
  createdAt: number;
  /** Id of an auto-drive run triggered from this task, if any. */
  runId?: string;
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
}

export interface RuntimeState {
  agents: AgentState[];
  harness: HarnessState;
  departments: Department[];
  tasks: Task[];
  autoDrive: {
    /** The active run, if any. */
    current: AutoDriveRun | null;
    /** Last 10 finished runs, newest first. */
    history: AutoDriveRun[];
  };
}

const CONFIG_DIR = path.join(
  process.env.CODEX_GATEWAY_CONFIG_DIR || os.homedir() || ".",
  ".codex-gateway",
);
const STATE_FILE = path.join(CONFIG_DIR, "mission-control.json");

const SEED_TASKS: Task[] = [
  { id: "T-101", title: "Wire OAuth device flow to gateway", column: "shipped", tag: "auth", createdAt: 0 },
  { id: "T-102", title: "Mission Control 3-panel shell", column: "shipped", tag: "ui", createdAt: 0 },
  { id: "T-103", title: "Embed Monaco workspace tab", column: "shipped", tag: "editor", createdAt: 0 },
  { id: "T-104", title: "Real PTY for in-browser terminal", column: "shipped", tag: "infra", createdAt: 0 },
  { id: "T-105", title: "Departments + cron matrix", column: "shipped", tag: "ops", createdAt: 0 },
  { id: "T-106", title: "Full Auto Drive safety rails", column: "shipped", tag: "safety", createdAt: 0 },
];

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
  },
  departments: [
    { id: "engineering", name: "Engineering", cron: [] },
    { id: "product", name: "Product", cron: [] },
    { id: "ops", name: "Ops", cron: [] },
  ],
  tasks: SEED_TASKS,
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
      // First launch — keep defaults.
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
    }));
  }
  return merged;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("base64url")}`;
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
