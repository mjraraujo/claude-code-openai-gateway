"use client";

import { useState } from "react";

type Tab = "terminal" | "workspace" | "side-by-side";

const TABS: { id: Tab; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "workspace", label: "Workspace" },
  { id: "side-by-side", label: "Side-by-Side" },
];

export function WorkspaceCenter() {
  const [tab, setTab] = useState<Tab>("terminal");

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

      <div className="flex-1 overflow-hidden">
        {tab === "terminal" && <TerminalView />}
        {tab === "workspace" && <WorkspaceView />}
        {tab === "side-by-side" && <SideBySideView />}
      </div>
    </section>
  );
}

function TerminalView() {
  return (
    <div className="flex h-full flex-col bg-black p-4 font-mono text-[12px] leading-6 text-zinc-300">
      <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          claude-code · gateway://localhost:18923
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-emerald-400">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
          connected
        </span>
      </div>
      <div className="flex-1 overflow-y-auto pt-3">
        <p className="text-zinc-500">$ claude-codex</p>
        <p>╔══════════════════════════════════════════════════╗</p>
        <p>║   🚀 Codex Gateway — OpenAI Login for Claude    ║</p>
        <p>╚══════════════════════════════════════════════════╝</p>
        <p className="text-zinc-500">  Model: gpt-5.4  |  API: chatgpt.com/backend-api/codex</p>
        <p>  🔑 Using cached token (still valid)</p>
        <p>  ✅ Proxy running on http://localhost:18923</p>
        <p>  🚀 Launching Claude Code...</p>
        <p className="mt-3 text-zinc-500">
          ─────────────────────────────────────────────────
        </p>
        <p className="mt-2 text-zinc-400">
          {">"} Ready. Type a prompt to begin.
        </p>
        <p className="mt-3">
          <span className="text-emerald-400">$</span>{" "}
          <span className="inline-block h-3 w-1.5 translate-y-0.5 animate-pulse bg-zinc-200" />
        </p>
      </div>
      <p className="mt-3 border-t border-zinc-900 pt-2 text-[10px] text-zinc-600">
        Interactive PTY arrives in the next milestone — see the roadmap in{" "}
        <code>web/README.md</code>.
      </p>
    </div>
  );
}

function WorkspaceView() {
  return (
    <div className="flex h-full">
      <div className="w-56 shrink-0 border-r border-zinc-900 bg-black p-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          Explorer
        </p>
        <ul className="mt-3 space-y-1 text-xs text-zinc-300">
          {[
            "src/app/page.tsx",
            "src/lib/auth/codex.ts",
            "src/lib/auth/storage.ts",
            "bin/gateway.js",
            "server.js",
            "README.md",
          ].map((p) => (
            <li
              key={p}
              className="cursor-pointer truncate rounded px-2 py-1 hover:bg-zinc-900"
            >
              {p}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-1 flex-col">
        <div className="border-b border-zinc-900 bg-zinc-950 px-3 py-1.5 font-mono text-[11px] text-zinc-400">
          src/app/page.tsx
        </div>
        <pre className="flex-1 overflow-auto bg-[#0a0a0a] p-4 font-mono text-[12px] leading-6 text-zinc-300">
          {`import { MissionControl } from "@/components/mission-control";

export default function Home() {
  return <MissionControl />;
}
`}
        </pre>
        <p className="border-t border-zinc-900 bg-black px-3 py-1.5 text-[10px] text-zinc-600">
          Monaco Editor will be wired here in the next milestone (dynamic
          import; ships unused weight only on this tab).
        </p>
      </div>
    </div>
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
        <div
          key={lane.name}
          className="flex flex-col bg-black"
        >
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
