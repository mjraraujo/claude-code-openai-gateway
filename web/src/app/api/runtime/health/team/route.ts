/**
 * GET /api/runtime/health/team
 *
 * Cheap, read-only summary of how engaged the configured team is:
 *   - which `agents/*.md` files are loaded for the active workspace,
 *   - which agents have been touched in the last hour
 *     (their last `lastRun` / `lastError` timestamp),
 *   - whether an auto-drive run is currently active,
 *   - the active methodology + dev-mode and whether the matching
 *     scaffolding has been recorded for the active workspace.
 *
 * Used by the AgentsPanel "Team status" widget (PR 8) and by the
 * startup self-check that logs warnings on first SSE state load.
 *
 * Auth: same session cookie as every other /api/runtime/* route.
 */

import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { activeWorkspace, getStore } from "@/lib/runtime";
import { loadAgentsFromWorkspace } from "@/lib/runtime/agentsLoader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const state = await getStore().snapshot();
  const ws = activeWorkspace(state);

  // Loaded `agents/*.md` for the active workspace. Failures (no
  // agents/ dir, unreadable files) just yield an empty list — the
  // self-check below interprets that as "operator hasn't seeded yet".
  let loadedAgents: { id: string; name: string; role?: string }[] = [];
  try {
    loadedAgents = (await loadAgentsFromWorkspace(ws.root)).map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
    }));
  } catch {
    /* ignore */
  }

  // "Engaged" = the agent's id appears in a recent step of the
  // current or last auto-drive run. AgentState doesn't carry a
  // per-agent `lastRun` timestamp today, so we derive engagement
  // from the auto-drive history instead — good enough for the
  // amber/grey/green dot the AgentsPanel will render.
  const engagedIds = new Set<string>();
  const run = state.autoDrive.current ?? state.autoDrive.history[0];
  if (run) {
    for (const step of run.steps ?? []) {
      const aid =
        (step.data as { agentId?: unknown } | undefined)?.agentId;
      if (typeof aid === "string") engagedIds.add(aid);
    }
  }
  const engaged = state.agents
    .filter((a) => engagedIds.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, status: a.status }));

  const scaffold = state.scaffolds.find((s) => s.workspaceId === ws.id);

  return NextResponse.json({
    workspace: { id: ws.id, name: ws.name, root: ws.root },
    methodology: state.harness.methodology,
    devMode: state.harness.devMode,
    scaffolded: {
      methodology: scaffold?.methodology ?? null,
      devMode: scaffold?.devMode ?? null,
      filesSeeded: scaffold?.filesSeeded ?? [],
    },
    autoDriveActive: !!state.autoDrive.current,
    agentsFromMarkdown: loadedAgents,
    agentsEngaged: engaged,
    agentsTotal: state.agents.length,
    generatedAt: Date.now(),
  });
}
