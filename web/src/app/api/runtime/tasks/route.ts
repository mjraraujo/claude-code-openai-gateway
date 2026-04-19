import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getStore, newId, type Task, type TaskColumn } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_COLUMNS = new Set<TaskColumn>([
  "backlog",
  "active",
  "review",
  "shipped",
]);
const TAG_RE = /^[\w\-]{1,20}$/;

interface CreateBody {
  title?: unknown;
  column?: unknown;
  tag?: unknown;
}

interface PatchBody {
  id?: unknown;
  column?: unknown;
  title?: unknown;
  runId?: unknown;
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
    const task: Task = {
      id: newId("T"),
      title,
      column,
      tag,
      createdAt: Date.now(),
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
