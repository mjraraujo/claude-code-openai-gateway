import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { deleteSession, getSession } from "@/lib/pty/sessionManager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/** GET /api/pty/[id] — return session info (for reconnect). */
export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ session: s.info });
}

/** DELETE /api/pty/[id] — kill the session. */
export async function DELETE(
  _req: Request,
  ctx: RouteCtx,
): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const ok = deleteSession(id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
