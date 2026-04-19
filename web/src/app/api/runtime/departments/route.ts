import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getStore, newId } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateBody {
  name?: unknown;
}

interface DeleteBody {
  id?: unknown;
}

const NAME_RE = /^[\w\s\-./]{1,40}$/;

/** POST /api/runtime/departments  body: { name } — create. */
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
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || !NAME_RE.test(name)) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }
  const next = await getStore().update((draft) => {
    draft.departments.push({ id: newId("dept"), name, cron: [] });
  });
  return NextResponse.json({ departments: next.departments });
}

/** DELETE /api/runtime/departments  body: { id } */
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
    draft.departments = draft.departments.filter((d) => d.id !== id);
  });
  return NextResponse.json({ departments: next.departments });
}
