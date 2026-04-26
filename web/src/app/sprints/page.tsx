/**
 * Standalone full-bleed sprints view. See `/board` for the rationale.
 */

import { SprintPanel } from "@/components/claude-codex/SprintPanel";
import { RuntimeProvider } from "@/lib/runtime/client";

export const dynamic = "force-dynamic";

export default function SprintsPage() {
  return (
    <RuntimeProvider>
      <main className="h-screen w-screen bg-black text-zinc-100">
        <SprintPanel />
      </main>
    </RuntimeProvider>
  );
}
