import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getStore, newId, parseSchedule } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface CreateBody {
  schedule?: unknown;
  prompt?: unknown;
  maxSteps?: unknown;
}

interface DeleteBody {
  jobId?: unknown;
}

/** POST /api/runtime/departments/[id]/cron — add a cron job. */
export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id: deptId } = await ctx.params;
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const schedule = typeof body.schedule === "string" ? body.schedule.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const maxSteps =
    typeof body.maxSteps === "number" && Number.isFinite(body.maxSteps)
      ? Math.max(1, Math.min(6, Math.floor(body.maxSteps)))
      : 3;
  if (!schedule || parseSchedule(schedule) == null) {
    return NextResponse.json({ error: "invalid_schedule" }, { status: 400 });
  }
  if (!prompt || prompt.length > 500) {
    return NextResponse.json({ error: "invalid_prompt" }, { status: 400 });
  }
  let added = false;
  const next = await getStore().update((draft) => {
    const dept = draft.departments.find((d) => d.id === deptId);
    if (!dept) return;
    dept.cron.push({
      id: newId("cron"),
      schedule,
      prompt,
      maxSteps,
    });
    added = true;
  });
  if (!added) {
    return NextResponse.json({ error: "department_not_found" }, { status: 404 });
  }
  return NextResponse.json({ departments: next.departments });
}

/** DELETE /api/runtime/departments/[id]/cron  body: { jobId } */
export async function DELETE(
  req: Request,
  ctx: RouteContext,
): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id: deptId } = await ctx.params;
  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  if (!jobId) {
    return NextResponse.json({ error: "missing_job_id" }, { status: 400 });
  }
  const next = await getStore().update((draft) => {
    const dept = draft.departments.find((d) => d.id === deptId);
    if (!dept) return;
    dept.cron = dept.cron.filter((c) => c.id !== jobId);
  });
  return NextResponse.json({ departments: next.departments });
}
