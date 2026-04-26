"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  agentsClient,
  autoDriveClient,
  harnessClient,
  useRuntimeState,
} from "@/lib/runtime/client";
import type {
  AgentState,
  AutoDriveRun,
  CronJob,
  Department,
  HarnessState,
  RufloPersona,
} from "@/lib/runtime";
import { DEFAULT_MODEL_ID, MODEL_PRESETS, findPreset } from "@/lib/runtime/models";

// Shared list also consumed by ChatDock and the Settings drawer.
const MODELS = MODEL_PRESETS;

const STATUS_COLORS = {
  active: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]",
  idle: "bg-zinc-600",
  blocked: "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.7)]",
} as const;

/** Sentinel value for the "All departments" filter option. */
const ALL_DEPARTMENTS = "__all__";
/** Sentinel value for "no department assigned" in the filter dropdown. */
const NO_DEPARTMENT = "__none__";

export function AgentsPanel() {
  const state = useRuntimeState();
  const [showAutoDriveModal, setShowAutoDriveModal] = useState(false);
  const [showRunLog, setShowRunLog] = useState(false);
  const [showDeptModal, setShowDeptModal] = useState<Department | null>(null);
  const [editingAgent, setEditingAgent] = useState<AgentState | null>(null);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [departmentFilter, setDepartmentFilter] = useState<string>(
    ALL_DEPARTMENTS,
  );

  const messageOf = (err: unknown): string => {
    if (err instanceof ApiError) return err.message;
    return (err as Error)?.message ?? String(err);
  };

  const harness = state?.harness;
  const agents = state?.agents ?? [];
  const departments = state?.departments ?? [];
  const currentRun = state?.autoDrive.current ?? null;
  const lastRun = state?.autoDrive.history[0] ?? null;
  // Model is sourced from persisted harness so Kanban "▶ run" and the
  // Engage modal both pick up whichever value was last selected here,
  // and the value survives reloads.
  const model = harness?.model ?? DEFAULT_MODEL_ID;
  const knownModel = findPreset(model);
  const modelRoute = knownModel?.route ?? "custom route";

  // The set of distinct department ids referenced by agents — drives
  // the filter dropdown together with the formal `state.departments`.
  // Using a Set + sort keeps the order stable across renders.
  const agentDepartments = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents) {
      if (a.department) set.add(a.department);
    }
    return Array.from(set).sort();
  }, [agents]);

  const visibleAgents = useMemo(() => {
    if (departmentFilter === ALL_DEPARTMENTS) return agents;
    if (departmentFilter === NO_DEPARTMENT) {
      return agents.filter((a) => !a.department);
    }
    return agents.filter((a) => a.department === departmentFilter);
  }, [agents, departmentFilter]);

  const patchHarness = useCallback(
    async (patch: Partial<HarnessState>) => {
      setError(null);
      try {
        await harnessClient.patch(patch);
      } catch (err) {
        setError(messageOf(err));
      }
    },
    [],
  );

  const deleteAgent = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await agentsClient.remove(id);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const onAutoDriveClick = () => {
    if (currentRun) {
      void stopAutoDrive(setBusy, setError);
    } else {
      setShowAutoDriveModal(true);
    }
  };

  return (
    <aside className="flex h-full w-full flex-col gap-4 overflow-y-auto border-l border-zinc-900 bg-black p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-200">Agents &amp; Routing</h2>
        {state == null && (
          <span className="font-mono text-[10px] text-zinc-600">connecting…</span>
        )}
      </div>

      <section className="flex flex-col gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
          model
        </span>
        <select
          value={model}
          disabled={!harness}
          onChange={(e) => void patchHarness({ model: e.target.value })}
          className="rounded-md border border-zinc-800 bg-black px-2 py-1.5 text-xs text-zinc-200 hover:border-zinc-700 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
        >
          {/*
            Render the persisted model first even if it's not in the
            preset list — guarantees the dropdown reflects state for
            custom values set via the API.
          */}
          {!knownModel && (
            <option value={model}>{model} (custom)</option>
          )}
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <p className="font-mono text-[10px] text-zinc-500">→ {modelRoute}</p>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
            active agents
          </span>
          <button
            type="button"
            onClick={() => setShowAddAgent(true)}
            className="rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
          >
            + Add
          </button>
        </div>
        {(agentDepartments.length > 0 || departments.length > 0) && (
          <select
            value={departmentFilter}
            onChange={(e) => setDepartmentFilter(e.target.value)}
            className="rounded border border-zinc-800 bg-black px-2 py-1 text-[10px] text-zinc-300"
            aria-label="Filter agents by department"
          >
            <option value={ALL_DEPARTMENTS}>All departments</option>
            <option value={NO_DEPARTMENT}>(no department)</option>
            {/* Show departments referenced by agents first; then any
                formal departments from `state.departments` that aren't
                already represented by an agent. Avoids duplicates. */}
            {agentDepartments.map((d) => (
              <option key={`agent-${d}`} value={d}>
                {d}
              </option>
            ))}
            {departments
              .filter((d) => !agentDepartments.includes(d.name))
              .map((d) => (
                <option key={d.id} value={d.name}>
                  {d.name}
                </option>
            ))}
          </select>
        )}
        <ul className="space-y-1.5">
          {visibleAgents.map((a) => {
            const effectiveModel = a.model || model;
            const overridden = !!a.model && a.model !== model;
            return (
              <li
                key={a.id}
                className="rounded-md border border-zinc-900 bg-zinc-950/60 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className={
                        "inline-block h-1.5 w-1.5 rounded-full " +
                        STATUS_COLORS[a.status]
                      }
                    />
                    <span className="truncate text-xs text-zinc-200">
                      {a.name}
                    </span>
                    {a.department && (
                      <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-zinc-400">
                        {a.department}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span
                      title={overridden ? "per-agent model override" : "global model"}
                      className={
                        "font-mono text-[10px] " +
                        (overridden ? "text-emerald-400" : "text-zinc-500")
                      }
                    >
                      {a.skill && a.skill !== "—" ? a.skill : effectiveModel}
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditingAgent(a)}
                      title="Edit agent"
                      aria-label={`Edit ${a.name}`}
                      className="rounded border border-zinc-900 px-1 text-[10px] text-zinc-600 hover:border-zinc-800 hover:text-zinc-300"
                    >
                      ✎
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
          {visibleAgents.length === 0 && (
            <li className="rounded-md border border-dashed border-zinc-900 px-2 py-3 text-center text-[10px] text-zinc-600">
              {agents.length === 0
                ? "no agents — click + Add"
                : "no agents in this department"}
            </li>
          )}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
          harness
        </span>
        <div className="space-y-1 rounded-md border border-zinc-900 bg-zinc-950/60 p-2.5 text-xs text-zinc-300">
          <Toggle
            label="Auto-approve safe edits"
            checked={harness?.autoApproveSafeEdits ?? false}
            onChange={(v) => patchHarness({ autoApproveSafeEdits: v })}
          />
          <Toggle
            label="Stream tool output"
            checked={harness?.streamToolOutput ?? false}
            onChange={(v) => patchHarness({ streamToolOutput: v })}
          />
          <Toggle
            label="Persist context"
            checked={harness?.persistContext ?? false}
            onChange={(v) => patchHarness({ persistContext: v })}
          />
          <PersonaSelect
            persona={harness?.persona ?? "core"}
            disabled={!harness}
            onChange={(p) => patchHarness({ persona: p })}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
            departments
          </span>
          <AddDepartmentButton onCreated={() => undefined /* SSE will push */} />
        </div>
        <ul className="space-y-1 rounded-md border border-zinc-900 bg-zinc-950/60 p-2.5 text-xs text-zinc-300">
          {departments.map((d) => (
            <li key={d.id} className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setShowDeptModal(d)}
                className="flex-1 text-left text-zinc-200 hover:text-zinc-50"
              >
                {d.name}
              </button>
              <span className="font-mono text-[10px] text-zinc-500">
                {d.cron.length} cron
              </span>
            </li>
          ))}
          {departments.length === 0 && (
            <li className="text-center text-[10px] text-zinc-600">
              no departments
            </li>
          )}
        </ul>
      </section>

      <section className="mt-auto flex flex-col gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
          full auto drive
        </span>
        <button
          type="button"
          onClick={onAutoDriveClick}
          disabled={busy}
          aria-pressed={!!currentRun}
          className={
            "flex items-center justify-between rounded-md border px-3 py-2 text-xs transition disabled:opacity-50 " +
            (currentRun
              ? "border-red-500/60 bg-red-500/10 text-red-300 hover:border-red-500"
              : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:border-zinc-700")
          }
        >
          <span className="flex items-center gap-2">
            <span
              className={
                "inline-block h-1.5 w-1.5 rounded-full " +
                (currentRun
                  ? "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.7)] animate-pulse"
                  : "bg-zinc-600")
              }
            />
            {currentRun
              ? `ENGAGED — step ${currentRun.steps.length}`
              : "Disengaged"}
          </span>
          <span className="font-mono text-[10px] uppercase">
            {currentRun ? "stop" : "engage"}
          </span>
        </button>
        {currentRun?.mode === "endless" && currentRun.sdlc ? (
          <SdlcBar sdlc={currentRun.sdlc} />
        ) : null}
        {(currentRun || lastRun) && (
          <button
            type="button"
            onClick={() => setShowRunLog(true)}
            className="rounded-md border border-zinc-900 px-2 py-1 text-left text-[11px] text-zinc-400 hover:border-zinc-800 hover:text-zinc-200"
          >
            View {currentRun ? "live" : "last"} run log →
          </button>
        )}
        {/*
          Force-clear escape hatch. The auto-drive singleton is held in
          process memory; if the loop crashes in a way that bypasses
          the normal terminate path we'd be stuck unable to start a
          new run. This button asks the server to scrub the singleton
          and any dangling `current` state. Always shown — it's a
          no-op when there's nothing to clear.
        */}
        <button
          type="button"
          onClick={() => void forceStopAutoDrive(setBusy, setError)}
          disabled={busy}
          className="rounded-md border border-zinc-900 px-2 py-1 text-left text-[11px] text-zinc-500 hover:border-zinc-800 hover:text-zinc-300 disabled:opacity-50"
          title="Force-clear a stuck auto-drive (use when 'engage' returns auto_drive_already_running but no run is visible)"
        >
          Force stop / clear
        </button>
        <p className="font-mono text-[10px] leading-4 text-zinc-600">
          Continuous, looped agent execution. Per-step + wall-time + byte
          budgets enforced server-side.
        </p>
        {error && (
          <p className="font-mono text-[10px] text-red-400">{error}</p>
        )}
      </section>

      {showAutoDriveModal && (
        <AutoDriveConfirm
          busy={busy}
          defaultMode={harness?.driveMode ?? "bounded"}
          onCancel={() => setShowAutoDriveModal(false)}
          onConfirm={async (goal, maxSteps, driveMode) => {
            setShowAutoDriveModal(false);
            await startAutoDrive(
              { goal, maxSteps, driveMode },
              setBusy,
              setError,
            );
          }}
        />
      )}

      {showRunLog && (
        <RunLogModal
          run={currentRun ?? lastRun}
          onClose={() => setShowRunLog(false)}
        />
      )}

      {showDeptModal && (
        <DepartmentModal
          department={
            departments.find((d) => d.id === showDeptModal.id) ?? showDeptModal
          }
          onClose={() => setShowDeptModal(null)}
          onError={setError}
        />
      )}

      {showAddAgent && (
        <AgentEditorModal
          mode="create"
          allDepartments={[
            ...new Set([
              ...agentDepartments,
              ...departments.map((d) => d.name),
            ]),
          ].sort()}
          globalModel={model}
          onClose={() => setShowAddAgent(false)}
          onError={setError}
        />
      )}

      {editingAgent && (
        <AgentEditorModal
          mode="edit"
          agent={editingAgent}
          allDepartments={[
            ...new Set([
              ...agentDepartments,
              ...departments.map((d) => d.name),
            ]),
          ].sort()}
          globalModel={model}
          onClose={() => setEditingAgent(null)}
          onDelete={async () => {
            await deleteAgent(editingAgent.id);
            setEditingAgent(null);
          }}
          onError={setError}
        />
      )}
    </aside>
  );
}

async function startAutoDrive(
  body: { goal: string; maxSteps?: number; driveMode?: "bounded" | "endless" },
  setBusy: (b: boolean) => void,
  setError: (e: string | null) => void,
): Promise<void> {
  setBusy(true);
  setError(null);
  try {
    await autoDriveClient.start(body);
  } catch (err) {
    setError(err instanceof ApiError ? err.message : (err as Error).message);
  } finally {
    setBusy(false);
  }
}

async function stopAutoDrive(
  setBusy: (b: boolean) => void,
  setError: (e: string | null) => void,
): Promise<void> {
  setBusy(true);
  setError(null);
  try {
    await autoDriveClient.stop();
  } catch (err) {
    setError(err instanceof ApiError ? err.message : (err as Error).message);
  } finally {
    setBusy(false);
  }
}

async function forceStopAutoDrive(
  setBusy: (b: boolean) => void,
  setError: (e: string | null) => void,
): Promise<void> {
  setBusy(true);
  setError(null);
  try {
    await autoDriveClient.forceStop();
  } catch (err) {
    setError(err instanceof ApiError ? err.message : (err as Error).message);
  } finally {
    setBusy(false);
  }
}

/* ─── small subcomponents ─────────────────────────────────────────── */

/**
 * SDLC progress strip shown while an endless-mode auto-drive is in
 * flight. Renders one cell per stage with a colour matching the gate
 * status (green/red/pending) and bolds the stage the loop is
 * currently working on.
 */
function SdlcBar({ sdlc }: { sdlc: import("@/lib/runtime").SdlcState }) {
  const STAGES = ["spec", "bdd", "impl", "test", "deploy"] as const;
  return (
    <div className="rounded-md border border-zinc-900 bg-zinc-950/40 px-2 py-1.5">
      <div className="flex items-center justify-between text-[9px] uppercase tracking-[0.2em] text-zinc-500">
        <span>sdlc</span>
        <span className="text-zinc-600">
          {sdlc.stage === "delivered" ? "delivered ✓" : `→ ${sdlc.stage}`}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-5 gap-1">
        {STAGES.map((s) => {
          const status = sdlc.gates[s];
          const active = sdlc.stage === s;
          const colour =
            status === "green"
              ? "bg-emerald-500/70"
              : status === "red"
                ? "bg-red-500/70"
                : "bg-zinc-800";
          return (
            <div key={s} className="flex flex-col items-center gap-0.5">
              <span
                className={
                  "block h-1.5 w-full rounded-full " +
                  colour +
                  (active ? " ring-1 ring-cyan-400/70" : "")
                }
              />
              <span
                className={
                  "font-mono text-[9px] " +
                  (active ? "text-cyan-300" : "text-zinc-500")
                }
              >
                {s}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between py-0.5">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={
          "relative h-4 w-7 rounded-full transition " +
          (checked ? "bg-emerald-500" : "bg-zinc-800")
        }
      >
        <span
          className={
            "absolute top-0.5 h-3 w-3 rounded-full bg-white transition " +
            (checked ? "left-3.5" : "left-0.5")
          }
        />
      </button>
    </label>
  );
}

function AddDepartmentButton({ onCreated }: { onCreated: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/runtime/departments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `create failed (${res.status})`);
      }
      setName("");
      setEditing(false);
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setEditing(false);
    setName("");
    setError(null);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
      >
        + Add
      </button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") cancel();
          }}
          disabled={busy}
          placeholder="name"
          className="w-24 rounded border border-zinc-800 bg-black px-1.5 py-0.5 text-[10px] text-zinc-200 focus:border-zinc-600 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !name.trim()}
          className="rounded border border-emerald-700/60 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300 hover:border-emerald-600 disabled:opacity-50"
        >
          {busy ? "…" : "Save"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="font-mono text-[10px] text-red-400">{error}</p>
      )}
    </div>
  );
}

function AutoDriveConfirm({
  busy,
  defaultMode,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  defaultMode: "bounded" | "endless";
  onCancel: () => void;
  onConfirm: (
    goal: string,
    maxSteps: number,
    driveMode: "bounded" | "endless",
  ) => void;
}) {
  const [goal, setGoal] = useState("");
  const [maxSteps, setMaxSteps] = useState(8);
  const [driveMode, setDriveMode] = useState<"bounded" | "endless">(
    defaultMode,
  );
  const ready = goal.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/80 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="autodrive-title"
    >
      <div className="flex h-full w-full max-w-full flex-col overflow-y-auto border-0 border-red-500/40 bg-zinc-950 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:h-auto sm:max-w-md sm:rounded-lg sm:border">
        <h3 id="autodrive-title" className="text-base font-semibold text-red-300">
          Engage Full Auto Drive?
        </h3>
        <p className="mt-3 text-sm leading-6 text-zinc-300">
          Agents loop autonomously: planner → tool → result → repeat. Hard
          guardrails stop the run when any of them fires.
        </p>
        <div className="mt-4 space-y-3">
          <fieldset className="block">
            <legend className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
              mode
            </legend>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <label
                className={
                  "cursor-pointer rounded border px-2 py-1.5 text-xs " +
                  (driveMode === "bounded"
                    ? "border-zinc-500 bg-zinc-900 text-zinc-100"
                    : "border-zinc-800 bg-black text-zinc-400 hover:border-zinc-700")
                }
              >
                <input
                  type="radio"
                  name="drive-mode"
                  value="bounded"
                  checked={driveMode === "bounded"}
                  onChange={() => setDriveMode("bounded")}
                  className="sr-only"
                />
                <span className="font-medium">bounded</span>
                <span className="block text-[10px] text-zinc-500">
                  one shot · step / wall / byte caps
                </span>
              </label>
              <label
                className={
                  "cursor-pointer rounded border px-2 py-1.5 text-xs " +
                  (driveMode === "endless"
                    ? "border-cyan-500/60 bg-cyan-500/10 text-cyan-100"
                    : "border-zinc-800 bg-black text-zinc-400 hover:border-zinc-700")
                }
              >
                <input
                  type="radio"
                  name="drive-mode"
                  value="endless"
                  checked={driveMode === "endless"}
                  onChange={() => setDriveMode("endless")}
                  className="sr-only"
                />
                <span className="font-medium">endless · SDLC</span>
                <span className="block text-[10px] text-zinc-500">
                  spec → bdd → impl → test → deploy · no caps
                </span>
              </label>
            </div>
          </fieldset>
          <label className="block text-xs">
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
              goal
            </span>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder="e.g. Survey the repository and summarise the README"
              className="mt-1 w-full rounded border border-zinc-800 bg-black px-2 py-1.5 text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
            />
          </label>
          {driveMode === "bounded" ? (
            <label className="block text-xs">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
                max steps (1–50)
              </span>
              <input
                type="number"
                min={1}
                max={50}
                value={maxSteps}
                onChange={(e) =>
                  setMaxSteps(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
                }
                className="mt-1 w-24 rounded border border-zinc-800 bg-black px-2 py-1.5 text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
              />
            </label>
          ) : null}
        </div>
        <p className="mt-3 text-[11px] leading-4 text-zinc-500">
          {driveMode === "bounded"
            ? "Server enforces a 5-minute wall-time and a 1 MB output budget on top of step count. Without a Codex token the planner runs in mock mode (no model calls) so you can verify the loop safely."
            : "Endless mode walks the SDLC state machine and only stops when every gate is green or you hit Stop. Step / wall / byte caps are disabled — circuit breaker stays in effect with larger thresholds."}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() => onConfirm(goal.trim(), maxSteps, driveMode)}
            className="rounded-md bg-red-500/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            {busy ? "starting…" : "I understand — engage"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RunLogModal({
  run,
  onClose,
}: {
  run: AutoDriveRun | null;
  onClose: () => void;
}) {
  const tailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: "end" });
  }, [run?.steps.length]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/80 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex h-full w-full max-w-full flex-col border-0 border-zinc-800 bg-zinc-950 pb-[env(safe-area-inset-bottom)] sm:h-[80vh] sm:max-w-2xl sm:rounded-lg sm:border sm:pb-0">
        <div className="flex items-center justify-between border-b border-zinc-900 px-4 py-2.5">
          <div>
            <p className="text-sm text-zinc-200">Auto Drive · {run?.id}</p>
            <p className="font-mono text-[10px] text-zinc-500">
              {run ? `${run.status} · ${run.steps.length} steps` : "no run"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-700"
          >
            Close
          </button>
        </div>
        <p className="border-b border-zinc-900 px-4 py-2 text-xs text-zinc-300">
          <span className="text-zinc-500">goal:</span> {run?.goal}
        </p>
        <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[11px] leading-5">
          {run?.steps.map((s) => (
            <div key={s.index} className={stepClass(s.kind)}>
              <span className="mr-2 text-zinc-600">
                #{s.index.toString().padStart(2, "0")}
              </span>
              <span className="mr-2 text-zinc-500">[{s.kind}]</span>
              <span className="whitespace-pre-wrap">{s.text}</span>
            </div>
          ))}
          {run && run.steps.length === 0 && (
            <p className="text-zinc-600">no steps yet — planner is thinking</p>
          )}
          <div ref={tailRef} />
        </div>
        {run?.reason && (
          <p className="border-t border-zinc-900 px-4 py-2 font-mono text-[10px] text-zinc-500">
            ended: {run.reason}
          </p>
        )}
      </div>
    </div>
  );
}

function stepClass(kind: string): string {
  switch (kind) {
    case "plan":
      return "text-sky-300";
    case "tool":
      return "text-emerald-300";
    case "tool_result":
      return "text-zinc-200";
    case "info":
      return "text-zinc-500";
    case "error":
      return "text-red-400";
    default:
      return "text-zinc-300";
  }
}

function DepartmentModal({
  department,
  onClose,
  onError,
}: {
  department: Department;
  onClose: () => void;
  onError: (e: string) => void;
}) {
  const [schedule, setSchedule] = useState("every 15m");
  const [prompt, setPrompt] = useState("");
  const [maxSteps, setMaxSteps] = useState(3);
  const [busy, setBusy] = useState(false);

  const fmtLast = useMemo(() => fmtRelative, []);

  const addJob = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/runtime/departments/${encodeURIComponent(department.id)}/cron`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ schedule, prompt: prompt.trim(), maxSteps }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `add failed (${res.status})`);
      }
      setPrompt("");
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeJob = async (jobId: string) => {
    setBusy(true);
    try {
      await fetch(
        `/api/runtime/departments/${encodeURIComponent(department.id)}/cron`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        },
      );
    } finally {
      setBusy(false);
    }
  };

  const removeDept = async () => {
    setBusy(true);
    try {
      await fetch("/api/runtime/departments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: department.id }),
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/80 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex h-full max-h-full w-full max-w-full flex-col border-0 border-zinc-800 bg-zinc-950 pb-[env(safe-area-inset-bottom)] sm:h-auto sm:max-h-[85vh] sm:max-w-xl sm:rounded-lg sm:border sm:pb-0">
        <div className="flex items-center justify-between border-b border-zinc-900 px-4 py-2.5">
          <h3 className="text-sm text-zinc-200">{department.name} · cron</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-700"
          >
            Close
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3">
          <ul className="space-y-2">
            {department.cron.map((j: CronJob) => (
              <li
                key={j.id}
                className="rounded border border-zinc-900 bg-zinc-950 p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                      {j.schedule} · max {j.maxSteps} steps
                    </p>
                    <p className="mt-1 truncate text-xs text-zinc-200">
                      {j.prompt}
                    </p>
                    {j.lastRunAt && (
                      <p className="mt-1 font-mono text-[10px] text-zinc-500">
                        last: {j.lastRunStatus} ·{" "}
                        {fmtLast(j.lastRunAt)} · {j.lastRunSummary}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeJob(j.id)}
                    className="rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-red-600 hover:text-red-300"
                  >
                    remove
                  </button>
                </div>
              </li>
            ))}
            {department.cron.length === 0 && (
              <li className="text-center text-[11px] text-zinc-600">
                no cron jobs
              </li>
            )}
          </ul>

          <div className="mt-4 space-y-2 rounded border border-zinc-900 p-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              add cron
            </p>
            <div className="flex gap-2">
              <select
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="rounded border border-zinc-800 bg-black px-2 py-1 text-xs text-zinc-200"
              >
                <option>every 5m</option>
                <option>every 15m</option>
                <option>every 1h</option>
                <option>@hourly</option>
                <option>@daily</option>
              </select>
              <input
                type="number"
                min={1}
                max={6}
                value={maxSteps}
                onChange={(e) =>
                  setMaxSteps(Math.max(1, Math.min(6, Number(e.target.value) || 1)))
                }
                className="w-16 rounded border border-zinc-800 bg-black px-2 py-1 text-xs text-zinc-200"
                title="max steps"
              />
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              placeholder="prompt for the agent…"
              className="w-full rounded border border-zinc-800 bg-black px-2 py-1.5 text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none"
            />
            <button
              type="button"
              disabled={!prompt.trim() || busy}
              onClick={addJob}
              className="rounded border border-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:border-zinc-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-zinc-900 px-4 py-2">
          <span className="font-mono text-[10px] text-zinc-600">
            {department.id}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={removeDept}
            className="rounded border border-red-900/60 px-2 py-0.5 text-[11px] text-red-300 hover:border-red-600 hover:bg-red-500/10"
          >
            Delete department
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtRelative(t: number): string {
  const diff = Date.now() - t;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Modal that handles both creating a new agent and editing an
 * existing one. Lets the operator set name + department + skill +
 * an optional per-agent model override (which falls back to the
 * global harness model when blank).
 */
function AgentEditorModal({
  mode,
  agent,
  allDepartments,
  globalModel,
  onClose,
  onDelete,
  onError,
}: {
  mode: "create" | "edit";
  agent?: AgentState;
  allDepartments: string[];
  globalModel: string;
  onClose: () => void;
  onDelete?: () => Promise<void> | void;
  onError: (e: string | null) => void;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [department, setDepartment] = useState(agent?.department ?? "");
  const [skill, setSkill] = useState(
    agent?.skill && agent.skill !== "—" ? agent.skill : "",
  );
  const [modelOverride, setModelOverride] = useState(agent?.model ?? "");
  const [busy, setBusy] = useState(false);
  const ready = name.trim().length > 0;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    onError(null);
    const trimmedName = name.trim();
    const trimmedDept = department.trim();
    const trimmedSkill = skill.trim();
    const trimmedModel = modelOverride.trim();
    try {
      if (mode === "edit") {
        // For edits, an empty model string means "clear the override".
        // The API accepts `null` as an explicit clear.
        await agentsClient.update({
          id: agent!.id,
          name: trimmedName,
          department: trimmedDept,
          skill: trimmedSkill,
          model: trimmedModel ? trimmedModel : null,
        });
      } else {
        await agentsClient.create({
          name: trimmedName,
          department: trimmedDept,
          skill: trimmedSkill,
          ...(trimmedModel ? { model: trimmedModel } : {}),
        });
      }
      onClose();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        `Delete agent "${agent?.name}"? This cannot be undone.`,
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await onDelete();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/80 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-editor-title"
    >
      <div className="flex h-full w-full max-w-full flex-col overflow-y-auto border-0 border-zinc-800 bg-zinc-950 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:h-auto sm:max-w-md sm:rounded-lg sm:border">
        <h3 id="agent-editor-title" className="text-base font-semibold text-zinc-100">
          {mode === "create" ? "Add agent" : `Edit ${agent?.name}`}
        </h3>
        <div className="mt-4 space-y-3">
          <Field label="name">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              className="mt-1 w-full rounded border border-zinc-800 bg-black px-2 py-1.5 text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
            />
          </Field>
          <Field label="department (optional)">
            <input
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              maxLength={40}
              list="agent-editor-departments"
              placeholder="e.g. engineering"
              className="mt-1 w-full rounded border border-zinc-800 bg-black px-2 py-1.5 text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
            />
            {allDepartments.length > 0 && (
              <datalist id="agent-editor-departments">
                {allDepartments.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
            )}
          </Field>
          <Field label="skill (optional)">
            <input
              value={skill}
              onChange={(e) => setSkill(e.target.value)}
              maxLength={60}
              placeholder="e.g. planner"
              className="mt-1 w-full rounded border border-zinc-800 bg-black px-2 py-1.5 text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
            />
          </Field>
          <Field
            label={`model override (blank = use global "${globalModel}")`}
          >
            <select
              value={modelOverride}
              onChange={(e) => setModelOverride(e.target.value)}
              className="mt-1 w-full rounded border border-zinc-800 bg-black px-2 py-1.5 text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
            >
              <option value="">(use global)</option>
              {/* Render the persisted override even if it's not in
                  the preset list, so the dropdown reflects state for
                  custom model ids set via the API. */}
              {modelOverride && !findPreset(modelOverride) && (
                <option value={modelOverride}>{modelOverride} (custom)</option>
              )}
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="mt-6 flex items-center justify-between gap-2">
          {mode === "edit" && onDelete ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleDelete()}
              className="rounded border border-red-900/60 px-2 py-1 text-[10px] text-red-400 hover:border-red-700 hover:bg-red-500/10 disabled:opacity-50"
            >
              delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!ready || busy}
              className="rounded-md border border-emerald-700/60 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:border-emerald-600 disabled:opacity-50"
            >
              {busy ? "…" : mode === "create" ? "Add" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
        {label}
      </span>
      {children}
    </label>
  );
}

const PERSONA_LABELS: Record<RufloPersona, { label: string; hint: string }> = {
  core: { label: "core", hint: "decompose · read first" },
  impl: { label: "impl", hint: "execute · write fast" },
  review: { label: "review", hint: "read-only by default" },
};

function PersonaSelect({
  persona,
  disabled,
  onChange,
}: {
  persona: RufloPersona;
  disabled: boolean;
  onChange: (next: RufloPersona) => void;
}) {
  const options: RufloPersona[] = ["core", "impl", "review"];
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span>Ruflo persona</span>
      <div
        role="radiogroup"
        aria-label="Ruflo persona"
        className="flex overflow-hidden rounded border border-zinc-800 bg-zinc-950"
      >
        {options.map((p) => {
          const selected = p === persona;
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(p)}
              title={PERSONA_LABELS[p].hint}
              className={
                "px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition disabled:opacity-50 " +
                (selected
                  ? "bg-emerald-500/20 text-emerald-200"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200")
              }
            >
              {PERSONA_LABELS[p].label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

