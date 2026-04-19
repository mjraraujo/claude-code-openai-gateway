"use client";

import { useState } from "react";

const MODELS = [
  { id: "gpt-5.4", label: "gpt-5.4", route: "Codex backend" },
  { id: "gpt-4o", label: "gpt-4o", route: "OpenAI Chat Completions" },
  { id: "sonnet-4.6", label: "claude-sonnet-4.6", route: "Anthropic" },
  { id: "haiku-4.5", label: "claude-haiku-4.5", route: "Anthropic" },
] as const;

interface AgentStatus {
  id: string;
  name: string;
  status: "active" | "idle" | "blocked";
  skill: string;
}

const AGENTS: AgentStatus[] = [
  { id: "ruflo-core", name: "ruflo · core", status: "active", skill: "spec.read" },
  { id: "ruflo-impl", name: "ruflo · impl", status: "active", skill: "edit.apply" },
  { id: "ruflo-review", name: "ruflo · review", status: "idle", skill: "—" },
  { id: "harness", name: "harness", status: "idle", skill: "—" },
];

const STATUS_COLORS: Record<AgentStatus["status"], string> = {
  active: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]",
  idle: "bg-zinc-600",
  blocked: "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.7)]",
};

export function AgentsPanel() {
  const [model, setModel] = useState<(typeof MODELS)[number]["id"]>("gpt-5.4");
  const [autoDrive, setAutoDrive] = useState(false);
  const [showAutoDriveModal, setShowAutoDriveModal] = useState(false);

  const onAutoDriveClick = () => {
    if (autoDrive) {
      setAutoDrive(false);
    } else {
      setShowAutoDriveModal(true);
    }
  };

  return (
    <aside className="flex h-full w-full flex-col gap-4 overflow-y-auto border-l border-zinc-900 bg-black p-4">
      <h2 className="text-sm font-medium text-zinc-200">Agents &amp; Routing</h2>

      <section className="flex flex-col gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
          model
        </span>
        <select
          value={model}
          onChange={(e) =>
            setModel(e.target.value as (typeof MODELS)[number]["id"])
          }
          className="rounded-md border border-zinc-800 bg-black px-2 py-1.5 text-xs text-zinc-200 hover:border-zinc-700 focus:border-zinc-600 focus:outline-none"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <p className="font-mono text-[10px] text-zinc-500">
          → {MODELS.find((m) => m.id === model)?.route}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
          active agents
        </span>
        <ul className="space-y-1.5">
          {AGENTS.map((a) => (
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
                {a.skill}
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
          <Toggle label="Auto-approve safe edits" defaultChecked />
          <Toggle label="Stream tool output" defaultChecked />
          <Toggle label="Persist context" />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
          departments
        </span>
        <ul className="space-y-1 rounded-md border border-zinc-900 bg-zinc-950/60 p-2.5 text-xs text-zinc-300">
          <li className="flex justify-between">
            <span>Engineering</span>
            <span className="font-mono text-[10px] text-zinc-500">2 cron</span>
          </li>
          <li className="flex justify-between">
            <span>Product</span>
            <span className="font-mono text-[10px] text-zinc-500">0 cron</span>
          </li>
          <li className="flex justify-between">
            <span>Ops</span>
            <span className="font-mono text-[10px] text-zinc-500">1 cron</span>
          </li>
        </ul>
        <button
          type="button"
          className="rounded-md border border-zinc-800 px-2 py-1 text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
        >
          + Add department
        </button>
      </section>

      <section className="mt-auto flex flex-col gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-500">
          full auto drive
        </span>
        <button
          type="button"
          onClick={onAutoDriveClick}
          aria-pressed={autoDrive}
          className={
            "flex items-center justify-between rounded-md border px-3 py-2 text-xs transition " +
            (autoDrive
              ? "border-red-500/60 bg-red-500/10 text-red-300 hover:border-red-500"
              : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:border-zinc-700")
          }
        >
          <span className="flex items-center gap-2">
            <span
              className={
                "inline-block h-1.5 w-1.5 rounded-full " +
                (autoDrive
                  ? "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.7)] animate-pulse"
                  : "bg-zinc-600")
              }
            />
            {autoDrive ? "ENGAGED — autonomous" : "Disengaged"}
          </span>
          <span className="font-mono text-[10px] uppercase">
            {autoDrive ? "stop" : "engage"}
          </span>
        </button>
        <p className="font-mono text-[10px] leading-4 text-zinc-600">
          Continuous, looped agent execution. Use with care.
        </p>
      </section>

      {showAutoDriveModal && (
        <AutoDriveConfirm
          onCancel={() => setShowAutoDriveModal(false)}
          onConfirm={() => {
            setAutoDrive(true);
            setShowAutoDriveModal(false);
          }}
        />
      )}
    </aside>
  );
}

function Toggle({
  label,
  defaultChecked = false,
}: {
  label: string;
  defaultChecked?: boolean;
}) {
  const [on, setOn] = useState(defaultChecked);
  return (
    <label className="flex cursor-pointer items-center justify-between py-0.5">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => setOn((v) => !v)}
        className={
          "relative h-4 w-7 rounded-full transition " +
          (on ? "bg-emerald-500" : "bg-zinc-800")
        }
      >
        <span
          className={
            "absolute top-0.5 h-3 w-3 rounded-full bg-white transition " +
            (on ? "left-3.5" : "left-0.5")
          }
        />
      </button>
    </label>
  );
}

function AutoDriveConfirm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="autodrive-title"
    >
      <div className="w-full max-w-md rounded-lg border border-red-500/40 bg-zinc-950 p-6">
        <h3
          id="autodrive-title"
          className="text-base font-semibold text-red-300"
        >
          Engage Full Auto Drive?
        </h3>
        <p className="mt-3 text-sm leading-6 text-zinc-300">
          Agents will loop autonomously, executing skills, file edits, and
          commands without per-step confirmation. This is the &ldquo;dangerous
          mode&rdquo; — only use it on disposable workspaces.
        </p>
        <ul className="mt-3 list-disc pl-5 text-xs text-zinc-400">
          <li>Tool calls run without approval</li>
          <li>Loop continues until you stop it or a guardrail fires</li>
          <li>Cost &amp; rate-limit responsibility is yours</li>
        </ul>
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
            onClick={onConfirm}
            className="rounded-md bg-red-500/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
          >
            I understand — engage
          </button>
        </div>
      </div>
    </div>
  );
}
