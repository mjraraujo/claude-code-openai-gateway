/**
 * /api/runtime/agents — CRUD for the Agents panel.
 *
 * Adds POST (create), PATCH (rename / set department / set per-agent
 * model override / change status / change skill) and DELETE on top
 * of the existing read-via-SSE flow. The store already validates
 * the optional `department` and `model` fields via
 * `normalizeAgent()` / `isValidModelId()` so we just shape the
 * mutator here.
 */

import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import {
  getStore,
  isValidModelId,
  newId,
  type AgentState,
  type AgentStatus,
} from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NAME_MAX = 60;
const DEPT_MAX = 40;
const SKILL_MAX = 60;

const VALID_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "active",
  "idle",
  "blocked",
]);

interface CreateBody {
  name?: unknown;
  department?: unknown;
  skill?: unknown;
  model?: unknown;
  status?: unknown;
}

interface PatchBody {
  id?: unknown;
  name?: unknown;
  department?: unknown;
  skill?: unknown;
  /** Pass `null` to clear the per-agent model override. */
  model?: unknown;
  status?: unknown;
}

interface DeleteBody {
  id?: unknown;
}

/** POST /api/runtime/agents  body: { name, department?, skill?, model?, status? } */
export async function POST(req: Request): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const name =
    typeof body.name === "string" ? body.name.trim().slice(0, NAME_MAX) : "";
  if (!name) {
    return NextResponse.json({ error: "missing_name" }, { status: 400 });
  }
  const department =
    typeof body.department === "string"
      ? body.department.trim().slice(0, DEPT_MAX) || undefined
      : undefined;
  const skill =
    typeof body.skill === "string" && body.skill.trim()
      ? body.skill.trim().slice(0, SKILL_MAX)
      : "—";
  let model: string | undefined;
  if (typeof body.model === "string" && body.model.trim()) {
    const trimmed = body.model.trim();
    if (!isValidModelId(trimmed)) {
      return NextResponse.json({ error: "invalid_model" }, { status: 400 });
    }
    model = trimmed;
  }
  const status: AgentStatus =
    typeof body.status === "string" && VALID_STATUSES.has(body.status as AgentStatus)
      ? (body.status as AgentStatus)
      : "idle";

  const next = await getStore().update((draft) => {
    const agent: AgentState = {
      id: newId("agent"),
      name,
      status,
      skill,
      department,
      model,
    };
    draft.agents.push(agent);
  });
  return NextResponse.json({ agents: next.agents });
}

/** PATCH /api/runtime/agents  body: { id, ...optional fields } */
export async function PATCH(req: Request): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  // Pre-validate any model id before we touch the store so we can
  // return a useful 400 instead of silently dropping it.
  if (typeof body.model === "string" && body.model.trim()) {
    if (!isValidModelId(body.model.trim())) {
      return NextResponse.json({ error: "invalid_model" }, { status: 400 });
    }
  }

  let found = false;
  const next = await getStore().update((draft) => {
    const agent = draft.agents.find((a) => a.id === id);
    if (!agent) return;
    found = true;
    if (typeof body.name === "string" && body.name.trim()) {
      agent.name = body.name.trim().slice(0, NAME_MAX);
    }
    if (typeof body.department === "string") {
      const dept = body.department.trim().slice(0, DEPT_MAX);
      agent.department = dept || undefined;
    }
    if (typeof body.skill === "string") {
      const skill = body.skill.trim().slice(0, SKILL_MAX);
      agent.skill = skill || "—";
    }
    if (body.model === null) {
      // Explicit null = clear the per-agent override (fall back to
      // the global harness model).
      agent.model = undefined;
    } else if (typeof body.model === "string") {
      const trimmed = body.model.trim();
      agent.model = trimmed ? trimmed : undefined;
    }
    if (
      typeof body.status === "string" &&
      VALID_STATUSES.has(body.status as AgentStatus)
    ) {
      agent.status = body.status as AgentStatus;
    }
  });
  if (!found) {
    return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
  }
  return NextResponse.json({ agents: next.agents });
}

/** DELETE /api/runtime/agents  body: { id } */
export async function DELETE(req: Request): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  const next = await getStore().update((draft) => {
    draft.agents = draft.agents.filter((a) => a.id !== id);
  });
  return NextResponse.json({ agents: next.agents });
}
