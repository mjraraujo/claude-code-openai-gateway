"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AmigosPanel } from "./AmigosPanel";
import { BrowserView } from "./BrowserView";
import { SideBySideView } from "./SideBySideView";
import { TerminalTabs } from "./TerminalTabs";
import { WorkspaceView } from "./WorkspaceView";
import { useNavigationStateContext } from "./NavigationStateProvider";
import { type WorkspaceTab } from "./navigationState";

const ALL_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "workspace", label: "Workspace" },
  { id: "side-by-side", label: "Side-by-Side" },
  { id: "browser", label: "Browser" },
  { id: "amigos", label: "Amigos" },
];

export interface WorkspaceCenterProps {
  /**
   * Hide the inline Terminal tab. The desktop shell now docks the
   * terminal as a resizable bottom panel via SplitPane, so the
   * tabbed copy would be a confusing duplicate. Defaults to false
   * so the MobileShell (which has no bottom dock) keeps its
   * Terminal tab.
   */
  hideTerminal?: boolean;
}

export function WorkspaceCenter({ hideTerminal = false }: WorkspaceCenterProps) {
  const { state, setWorkspaceTab } = useNavigationStateContext();
  const tab = state.workspaceTab;
  const tabs = useMemo(() => (hideTerminal ? ALL_TABS.filter((t) => t.id !== "terminal") : ALL_TABS), [hideTerminal]);
  // Track which tabs have been visited so each is mounted lazily on
  // first open (preserves Monaco's lazy-boot behavior) but stays
  // mounted thereafter — switching tabs must not abort an in-flight
  // terminal command or wipe scrollback / open editor buffers.
  const [visited, setVisited] = useState<Set<WorkspaceTab>>(() => new Set<WorkspaceTab>([tab]));

  useEffect(() => {
    if (hideTerminal && tab === "terminal") {
      setWorkspaceTab("workspace");
      return;
    }
    setVisited((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, [hideTerminal, setWorkspaceTab, tab]);

  const selectTab = useCallback((id: WorkspaceTab) => {
    setWorkspaceTab(id);
    setVisited((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, [setWorkspaceTab]);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-zinc-950">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-900 bg-black px-3 py-2">
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => selectTab(t.id)}
              className={
                "shrink-0 rounded-md px-3 py-1 text-xs font-medium transition " +
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
        Tabs are mounted lazily on first visit, then kept mounted
        and toggled with `hidden` so background work (running shell
        commands, SSE streams, dirty editor buffers) survives tab
        switches.
      */}
      <div className="relative flex-1 overflow-hidden">
        {!hideTerminal && visited.has("terminal") && (
          <div className={tab === "terminal" ? "h-full" : "hidden"}>
            <TerminalTabs />
          </div>
        )}
        {visited.has("workspace") && (
          <div className={tab === "workspace" ? "h-full" : "hidden"}>
            <WorkspaceView />
          </div>
        )}
        {visited.has("side-by-side") && (
          <div className={tab === "side-by-side" ? "h-full" : "hidden"}>
            <SideBySideView />
          </div>
        )}
        {visited.has("browser") && (
          <div className={tab === "browser" ? "h-full" : "hidden"}>
            <BrowserView />
          </div>
        )}
        {visited.has("amigos") && (
          <div className={tab === "amigos" ? "h-full" : "hidden"}>
            <AmigosPanel />
          </div>
        )}
      </div>
    </section>
  );
}
