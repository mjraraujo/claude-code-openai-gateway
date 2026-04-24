"use client";

import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { AgentsPanel } from "./AgentsPanel";
import { AmigosPanel } from "./AmigosPanel";
import { KanbanPanel } from "./KanbanPanel";
import { StatusBar } from "./StatusBar";
import { WorkspaceCenter } from "./WorkspaceCenter";
import { useNavigationStateContext } from "./NavigationStateProvider";
import { type MobileTab } from "./navigationState";

/**
 * Mobile-first single-pane shell.
 *
 * Renders one of the existing Claude Codex panels at a time, picked
 * via a bottom tab bar. The panels themselves are reused unchanged —
 * they all subscribe to the shared runtime SSE stream via the runtime
 * provider, so switching tabs does not re-fetch state and does not
 * interrupt any in-flight Auto Drive run.
 *
 * The bottom bar uses `pb-[env(safe-area-inset-bottom)]` so it clears
 * the iOS home indicator when the page is added to the home screen.
 *
 * The active tab lives in the shared `NavigationStateProvider` so it
 * survives a reload and stays in sync with the desktop right-rail
 * tab when the breakpoint flips.
 */
const TABS: { id: MobileTab; label: string; icon: string }[] = [
  { id: "tasks", label: "Tasks", icon: "▤" },
  { id: "workspace", label: "Workspace", icon: "▣" },
  { id: "amigos", label: "Amigos", icon: "✦" },
  { id: "agents", label: "Agents", icon: "◆" },
];

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

export function MobileShell() {
  const { state, setMobileTab } = useNavigationStateContext();
  const tab = state.mobileTab;

  // Keep panels mounted once visited so SSE subscriptions, terminal
  // scrollback, and Monaco buffers survive tab switches — same trick
  // WorkspaceCenter uses for its inner tabs.
  const [visited, setVisited] = useState<Set<MobileTab>>(
    () => new Set<MobileTab>([tab]),
  );

  useEffect(() => {
    setVisitedOnTab(tab, setVisited);
  }, [tab]);

  const select = useCallback(
    (id: MobileTab) => {
      setMobileTab(id);
      setVisitedOnTab(id, setVisited);
    },
    [setMobileTab],
  );

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
