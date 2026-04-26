/**
 * Standalone full-bleed Kanban view.
 *
 * Renders the existing `KanbanPanel` without the surrounding
 * dashboard chrome (no left rail, no terminal dock, no right rail)
 * so operators can pop the board out into its own browser tab. The
 * panel subscribes to the same `/api/runtime/state` SSE stream as
 * the dashboard, so card moves stay in sync across all open tabs.
 *
 * This route is referenced by the "↗ open in tab" button in the
 * dashboard's Kanban panel header.
 */

import { KanbanPanel } from "@/components/claude-codex/KanbanPanel";
import { RuntimeProvider } from "@/lib/runtime/client";

export const dynamic = "force-dynamic";

export default function BoardPage() {
  return (
    <RuntimeProvider>
      <main className="h-screen w-screen bg-black text-zinc-100">
        <KanbanPanel />
      </main>
    </RuntimeProvider>
  );
}
