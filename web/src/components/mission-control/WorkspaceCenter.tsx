"use client";

import { useState } from "react";

import { TerminalView } from "./TerminalView";
import { WorkspaceView } from "./WorkspaceView";

type Tab = "terminal" | "workspace" | "side-by-side";

const TABS: { id: Tab; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "workspace", label: "Workspace" },
  { id: "side-by-side", label: "Side-by-Side" },
];

export function WorkspaceCenter() {
  const [tab, setTab] = useState<Tab>("workspace");

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-zinc-950">
      <div className="flex items-center gap-1 border-b border-zinc-900 bg-black px-3 py-2">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={
                "rounded-md px-3 py-1 text-xs font-medium transition " +
                (active
                  ? "bg-zinc-900 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300")
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/*
        Each tab is mounted lazily and unmounted when hidden — this
        keeps Monaco from booting until the user opens the Workspace
        tab, and tears down the SSE connection when leaving Terminal.
      */}
      <div className="flex-1 overflow-hidden">
        {tab === "terminal" && <TerminalView />}
        {tab === "workspace" && <WorkspaceView />}
        {tab === "side-by-side" && <SideBySideView />}
      </div>
    </section>
  );
}

function SideBySideView() {
  const lanes: { name: string; tint: string; line: string }[] = [
    {
      name: "Codex",
      tint: "border-emerald-500/40",
      line: "# Codex (gpt-5.4)",
    },
    {
      name: "Claude Code",
      tint: "border-orange-500/40",
      line: "# Claude Code (sonnet-4.6)",
    },
    {
      name: "Copilot",
      tint: "border-sky-500/40",
      line: "# GitHub Copilot",
    },
  ];
  return (
    <div className="grid h-full grid-cols-3 gap-px bg-zinc-900">
      {lanes.map((lane) => (
        <div key={lane.name} className="flex flex-col bg-black">
          <div
            className={
              "flex items-center justify-between border-b px-3 py-2 " +
              lane.tint
            }
          >
            <span className="text-xs font-medium text-zinc-200">
              {lane.name}
            </span>
            <span className="font-mono text-[10px] text-zinc-500">idle</span>
          </div>
          <pre className="flex-1 overflow-auto p-3 font-mono text-[11px] leading-5 text-zinc-400">
            {lane.line}
            {"\n"}
            {">"} waiting for prompt…
          </pre>
        </div>
      ))}
    </div>
  );
}
