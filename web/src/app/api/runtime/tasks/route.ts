import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import {
  getStore,
  newId,
  normalizeAssignees,
  normalizeIsoDate,
  normalizeSubtasks,
  type Task,
  type TaskColumn,
} from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_COLUMNS = new Set<TaskColumn>([
  "backlog",
  "active",
  "review",
  "shipped",
]);
const TAG_RE = /^[\w\-]{1,20}$/;
const ID_RE = /^[\w.\-]{1,64}$/;

interface CreateBody {
  title?: unknown;
  column?: unknown;
  tag?: unknown;
  workspaceId?: unknown;
  dueDate?: unknown;
  assignees?: unknown;
  sprintId?: unknown;
}

interface PatchBody {
  id?: unknown;
  column?: unknown;
  title?: unknown;
  runId?: unknown;
  subtasks?: unknown;
  workspaceId?: unknown;
  dueDate?: unknown;
  assignees?: unknown;
  sprintId?: unknown;
}

interface DeleteBody {
  id?: unknown;
}

/** POST /api/runtime/tasks  body: { title, column?, tag? } — create a card. */
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
  const title =
    typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  if (!title) {
    return NextResponse.json({ error: "missing_title" }, { status: 400 });
  }
  const column: TaskColumn =
    typeof body.column === "string" && VALID_COLUMNS.has(body.column as TaskColumn)
      ? (body.column as TaskColumn)
      : "backlog";
  const tag =
    typeof body.tag === "string" && TAG_RE.test(body.tag)
      ? body.tag
      : undefined;

  const next = await getStore().update((draft) => {
    // Resolve workspaceId — explicit (must exist) or default to active.
    let workspaceId: string | undefined;
    if (typeof body.workspaceId === "string" && body.workspaceId) {
      if (!draft.workspaces.some((w) => w.id === body.workspaceId)) return;
      workspaceId = body.workspaceId;
    } else {
      workspaceId = draft.activeWorkspaceId;
    }
    // Resolve sprintId — must exist if provided.
    let sprintId: string | undefined;
    if (typeof body.sprintId === "string" && body.sprintId) {
      if (!draft.sprints.some((s) => s.id === body.sprintId)) return;
      sprintId = body.sprintId;
    }
    const task: Task = {
      id: newId("T"),
      title,
      column,
      tag,
      createdAt: Date.now(),
      workspaceId,
      sprintId,
      dueDate: normalizeIsoDate(body.dueDate),
      assignees: normalizeAssignees(body.assignees),
    };
    draft.tasks.push(task);
  });
  return NextResponse.json({ tasks: next.tasks });
}

/**
 * PATCH /api/runtime/tasks  body: { id, column?, title?, runId? }
 *
 * Moves a card to a new column, renames it, or records a run id.
 */
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
  let found = false;
  const next = await getStore().update((draft) => {
    const task = draft.tasks.find((t) => t.id === id);
    if (!task) return;
    found = true;
    if (
      typeof body.column === "string" &&
      VALID_COLUMNS.has(body.column as TaskColumn)
    ) {
      task.column = body.column as TaskColumn;
    }
    if (typeof body.title === "string" && body.title.trim()) {
      task.title = body.title.trim().slice(0, 200);
    }
    if (body.runId === null) {
      task.runId = undefined;
    } else if (typeof body.runId === "string") {
      task.runId = body.runId;
    }
    if (body.subtasks !== undefined) {
      // Full-array replacement: clients send the whole checklist,
      // server normalizes + clamps. A null or empty array clears the
      // list (stored as `undefined` to keep JSON minimal).
      if (body.subtasks === null) {
        task.subtasks = undefined;
      } else {
        task.subtasks = normalizeSubtasks(body.subtasks);
      }
    }
    if (body.workspaceId !== undefined) {
      if (body.workspaceId === null) {
        task.workspaceId = undefined;
      } else if (
        typeof body.workspaceId === "string" &&
        ID_RE.test(body.workspaceId) &&
        draft.workspaces.some((w) => w.id === body.workspaceId)
      ) {
        task.workspaceId = body.workspaceId;
      }
    }
    if (body.sprintId !== undefined) {
      if (body.sprintId === null) {
        task.sprintId = undefined;
      } else if (
        typeof body.sprintId === "string" &&
        ID_RE.test(body.sprintId) &&
        draft.sprints.some((s) => s.id === body.sprintId)
      ) {
        task.sprintId = body.sprintId;
      }
    }
    if (body.dueDate !== undefined) {
      // null clears; anything else goes through the validator
      // (ISO-8601, length-capped). Garbage is silently ignored.
      task.dueDate = body.dueDate === null ? undefined : normalizeIsoDate(body.dueDate);
    }
    if (body.assignees !== undefined) {
      // Full-array replacement, like subtasks.
      task.assignees =
        body.assignees === null ? undefined : normalizeAssignees(body.assignees);
    }
  });
  if (!found) {
    return NextResponse.json({ error: "task_not_found" }, { status: 404 });
  }
  return NextResponse.json({ tasks: next.tasks });
}

/** DELETE /api/runtime/tasks  body: { id } */
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
    draft.tasks = draft.tasks.filter((t) => t.id !== id);
  });
  return NextResponse.json({ tasks: next.tasks });
}
