import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import {
  getStore,
  newId,
  normalizeSubtasks,
  type Task,
  type TaskColumn,
} from "@/lib/runtime";
import { buildWebhookPayload, dispatchWebhook, type WebhookEvent } from "@/lib/runtime/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fire the configured outbound webhook in the background. Never
 * awaited by the request handler so a slow / broken endpoint cannot
 * delay or fail the Kanban API call. Errors are logged and dropped.
 */
function fireWebhook(event: WebhookEvent, before: Task | null, after: Task | null): void {
  // Defer reading the store until the next tick so the persist queue
  // has a chance to settle before we observe `harness.webhook`.
  void Promise.resolve()
    .then(async () => {
      const snap = await getStore().snapshot();
      const cfg = snap.harness.webhook;
      if (!cfg || !cfg.enabled || !cfg.url) return;
      const payload = buildWebhookPayload(event, before, after);
      const res = await dispatchWebhook(cfg, payload);
      if (!res.ok) {
        console.warn(
          `[webhook] ${event} delivery failed: ${res.error ?? "unknown"} (status=${res.status ?? "n/a"})`,
        );
      }
    })
    .catch((err) => {
      console.warn(`[webhook] ${event} dispatch crashed: ${(err as Error).message}`);
    });
}

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
  subtasks?: unknown;
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

  let createdTask: Task | null = null;
  const next = await getStore().update((draft) => {
    const task: Task = {
      id: newId("T"),
      title,
      column,
      tag,
      createdAt: Date.now(),
    };
    draft.tasks.push(task);
    createdTask = task;
  });
  if (createdTask) fireWebhook("task.created", null, createdTask);
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
  let beforeTask: Task | null = null;
  let afterTask: Task | null = null;
  const next = await getStore().update((draft) => {
    const task = draft.tasks.find((t) => t.id === id);
    if (!task) return;
    found = true;
    beforeTask = structuredClone(task);
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
    afterTask = structuredClone(task);
  });
  if (!found) {
    return NextResponse.json({ error: "task_not_found" }, { status: 404 });
  }
  if (beforeTask && afterTask) {
    const moved =
      (beforeTask as Task).column !== (afterTask as Task).column;
    fireWebhook(moved ? "task.moved" : "task.updated", beforeTask, afterTask);
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
  let deletedTask: Task | null = null;
  const next = await getStore().update((draft) => {
    const existing = draft.tasks.find((t) => t.id === id);
    if (existing) deletedTask = structuredClone(existing);
    draft.tasks = draft.tasks.filter((t) => t.id !== id);
  });
  if (deletedTask) fireWebhook("task.deleted", deletedTask, null);
  return NextResponse.json({ tasks: next.tasks });
}
