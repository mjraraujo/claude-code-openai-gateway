import { AgentsPanel } from "./AgentsPanel";
import { KanbanPanel } from "./KanbanPanel";
import { StatusBar } from "./StatusBar";
import { WorkspaceCenter } from "./WorkspaceCenter";

export function MissionControl() {
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
