"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { useNavigationStateContext } from "./NavigationStateProvider";
import { AgentsPanel } from "./AgentsPanel";
import { AmigosPanel } from "./AmigosPanel";
import { KanbanPanel } from "./KanbanPanel";
import { StatusBar } from "./StatusBar";
import { WorkspaceCenter } from "./WorkspaceCenter";
import { type MobileTab } from "./navigationState";

/**
 * Mobile-first single-pane shell.
 *
 * Renders one of the existing Claude Codex panels at a time, picked
 * via a bottom tab bar. The panels themselves are reused unchanged —
function setVisitedOnTab(
  tab: MobileTab,
  setVisited: Dispatch<SetStateAction<Set<MobileTab>>>,
) {
  setVisited((prev) => {
    if (prev.has(tab)) return prev;
    const next = new Set(prev);
    next.add(tab);
    return next;
  });
}
  const { state, setMobileTab } = useNavigationStateContext();
  const tab = state.mobileTab;
    () => new Set<MobileTab>([tab]),
  useEffect(() => {
    setVisitedOnTab(tab, setVisited);
  }, [tab]);

    setMobileTab(id);
    setVisitedOnTab(id, setVisited);
  { id: "tasks", label: "Tasks", icon: "▤" },
  { id: "workspace", label: "Workspace", icon: "▣" },
  { id: "amigos", label: "Amigos", icon: "✦" },
  { id: "agents", label: "Agents", icon: "◆" },
];

export function MobileShell() {
  const [tab, setTab] = useState<MobileTab>("workspace");
  // Keep panels mounted once visited so SSE subscriptions, terminal
  // scrollback, and Monaco buffers survive tab switches — same trick
  // WorkspaceCenter uses for its inner tabs.
  const [visited, setVisited] = useState<Set<MobileTab>>(
    () => new Set<MobileTab>(["workspace"]),
  );

  const select = (id: MobileTab) => {
    setTab(id);
    setVisited((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  return (
    <div className="flex h-[100dvh] w-screen flex-col bg-black text-zinc-100">
      <StatusBar />
      <main className="relative min-h-0 flex-1 overflow-hidden">
        {visited.has("tasks") && (
          <div
            className={
              "absolute inset-0 " + (tab === "tasks" ? "block" : "hidden")
            }
          >
            <KanbanPanel />
          </div>
        )}
        {visited.has("workspace") && (
          <div
            className={
              "absolute inset-0 " +
              (tab === "workspace" ? "block" : "hidden")
            }
          >
            <WorkspaceCenter />
          </div>
        )}
        {visited.has("amigos") && (
          <div
            className={
              "absolute inset-0 " + (tab === "amigos" ? "block" : "hidden")
            }
          >
            <AmigosPanel />
          </div>
        )}
        {visited.has("agents") && (
          <div
            className={
              "absolute inset-0 " + (tab === "agents" ? "block" : "hidden")
            }
          >
            <AgentsPanel />
          </div>
        )}
      </main>
      <nav
        aria-label="Claude Codex sections"
        className="flex shrink-0 items-stretch border-t border-zinc-900 bg-black pb-[env(safe-area-inset-bottom)]"
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => select(t.id)}
              aria-current={active ? "page" : undefined}
              className={
                "flex flex-1 flex-col items-center justify-center gap-0.5 py-2.5 text-[11px] font-medium transition " +
                (active
                  ? "text-emerald-300"
                  : "text-zinc-500 hover:text-zinc-300")
              }
            >
              <span aria-hidden className="text-base leading-none">
                {t.icon}
              </span>
              <span className="font-mono uppercase tracking-[0.15em]">
                {t.label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
