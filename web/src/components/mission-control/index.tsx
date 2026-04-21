"use client";

import { useBreakpoint } from "@/lib/hooks/useBreakpoint";

import { AgentsPanel } from "./AgentsPanel";
import { KanbanPanel } from "./KanbanPanel";
import { MobileShell } from "./MobileShell";
import { StatusBar } from "./StatusBar";
import { WorkspaceCenter } from "./WorkspaceCenter";

export function MissionControl() {
  // Below the lg (1024px) breakpoint we hand off to the single-pane
  // bottom-tab shell so the dashboard is usable on phones and small
  // tablets. The desktop 3-column grid is unchanged at >=lg.
  const bp = useBreakpoint();
  if (bp === "mobile") {
    return <MobileShell />;
  }
  return (
    <div className="flex h-screen w-screen flex-col bg-black text-zinc-100">
      <StatusBar />
      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_300px]">
        <KanbanPanel />
        <WorkspaceCenter />
        <AgentsPanel />
      </div>
    </div>
  );
}
