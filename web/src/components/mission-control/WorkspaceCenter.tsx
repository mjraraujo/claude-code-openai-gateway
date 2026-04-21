"use client";

import { useCallback, useState } from "react";

import { BrowserView } from "./BrowserView";
import { SideBySideView } from "./SideBySideView";
import { TerminalView } from "./TerminalView";
import { WebGPUView } from "./WebGPUView";
import { WorkspaceView } from "./WorkspaceView";

type Tab = "terminal" | "workspace" | "side-by-side" | "browser" | "webgpu";

const ALL_TABS: { id: Tab; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "workspace", label: "Workspace" },
  { id: "side-by-side", label: "Side-by-Side" },
  { id: "browser", label: "Browser" },
  { id: "webgpu", label: "WebGPU" },
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
  const TABS = hideTerminal ? ALL_TABS.filter((t) => t.id !== "terminal") : ALL_TABS;
  const [tab, setTab] = useState<Tab>("workspace");
  // Track which tabs have been visited so each is mounted lazily on
  // first open (preserves Monaco's lazy-boot behavior) but stays
  // mounted thereafter — switching tabs must not abort an in-flight
  // terminal command or wipe scrollback / open editor buffers.
  const [visited, setVisited] = useState<Set<Tab>>(
    () => new Set<Tab>(["workspace"]),
  );

  const selectTab = useCallback((id: Tab) => {
    setTab(id);
    setVisited((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-zinc-950">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-900 bg-black px-3 py-2">
        {TABS.map((t) => {
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
            <TerminalView />
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
        {visited.has("webgpu") && (
          <div className={tab === "webgpu" ? "h-full" : "hidden"}>
            <WebGPUView />
          </div>
        )}
      </div>
    </section>
  );
}
