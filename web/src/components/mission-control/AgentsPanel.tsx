"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AutoDriveRun,
  CronJob,
  Department,
  HarnessState,
  RuntimeState,
} from "@/lib/runtime";

const MODELS = [
  { id: "gpt-5.4", label: "gpt-5.4", route: "claude-codex backend" },
  { id: "gpt-4o", label: "gpt-4o", route: "OpenAI Chat Completions" },
  { id: "sonnet-4.6", label: "claude-sonnet-4.6", route: "Anthropic" },
  { id: "haiku-4.5", label: "claude-haiku-4.5", route: "Anthropic" },
] as const;

const STATUS_COLORS = {
  active: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]",
  idle: "bg-zinc-600",
  blocked: "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.7)]",
} as const;

export function AgentsPanel() {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [showAutoDriveModal, setShowAutoDriveModal] = useState(false);
  const [showRunLog, setShowRunLog] = useState(false);
  const [showDeptModal, setShowDeptModal] = useState<Department | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to runtime state via SSE.
  useEffect(() => {
    const es = new EventSource("/api/runtime/state");
    es.addEventListener("state", (ev) => {
      try {
        setState(JSON.parse((ev as MessageEvent).data) as RuntimeState);
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };
    return () => es.close();
  }, []);

  const harness = state?.harness;
  const agents = state?.agents ?? [];
  const departments = state?.departments ?? [];
  const currentRun = state?.autoDrive.current ?? null;
  const lastRun = state?.autoDrive.history[0] ?? null;
  // Model is sourced from persisted harness so Kanban "▶ run" and the
  // Engage modal both pick up whichever value was last selected here,
  // and the value survives reloads.
  const model = harness?.model ?? "gpt-5.4";
  const knownModel = MODELS.find((m) => m.id === model);
  const modelRoute = knownModel?.route ?? "custom route";

  const patchHarness = useCallback(
    async (patch: Partial<HarnessState>) => {
      setError(null);
      try {
        const res = await fetch("/api/runtime/harness", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`harness failed (${res.status})`);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [],
  );

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
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
          active agents
        </span>
        <ul className="space-y-1.5">
          {agents.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between rounded-md border border-zinc-900 bg-zinc-950/60 px-2.5 py-2"
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={
                    "inline-block h-1.5 w-1.5 rounded-full " +
                    STATUS_COLORS[a.status]
                  }
                />
                <span className="text-xs text-zinc-200">{a.name}</span>
              </div>
              <span className="font-mono text-[10px] text-zinc-500">
                {a.skill && a.skill !== "—" ? a.skill : model}
              </span>
            </li>
          ))}
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
        {(currentRun || lastRun) && (
          <button
            type="button"
            onClick={() => setShowRunLog(true)}
            className="rounded-md border border-zinc-900 px-2 py-1 text-left text-[11px] text-zinc-400 hover:border-zinc-800 hover:text-zinc-200"
          >
            View {currentRun ? "live" : "last"} run log →
          </button>
        )}
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
          onCancel={() => setShowAutoDriveModal(false)}
          onConfirm={async (goal, maxSteps) => {
            setShowAutoDriveModal(false);
            await startAutoDrive({ goal, maxSteps }, setBusy, setError);
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
    </aside>
  );
}

async function startAutoDrive(
  body: { goal: string; maxSteps?: number },
  setBusy: (b: boolean) => void,
  setError: (e: string | null) => void,
): Promise<void> {
  setBusy(true);
  setError(null);
  try {
    const res = await fetch("/api/runtime/auto-drive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start", ...body }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error || `start failed (${res.status})`);
    }
  } catch (err) {
    setError((err as Error).message);
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
    const res = await fetch("/api/runtime/auto-drive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    if (!res.ok) throw new Error(`stop failed (${res.status})`);
  } catch (err) {
    setError((err as Error).message);
  } finally {
    setBusy(false);
  }
}

/* ─── small subcomponents ─────────────────────────────────────────── */

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
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (goal: string, maxSteps: number) => void;
}) {
  const [goal, setGoal] = useState("");
  const [maxSteps, setMaxSteps] = useState(8);
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
        </div>
        <p className="mt-3 text-[11px] leading-4 text-zinc-500">
          Server enforces a 5-minute wall-time and a 1 MB output budget on top
          of step count. Without a Codex token the planner runs in mock mode
          (no model calls) so you can verify the loop safely.
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
            onClick={() => onConfirm(goal.trim(), maxSteps)}
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
