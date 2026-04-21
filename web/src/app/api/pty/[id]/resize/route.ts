import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getSession } from "@/lib/pty/sessionManager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface ResizeBody {
  cols?: unknown;
  rows?: unknown;
}

/**
 * POST /api/pty/[id]/resize — propagate the terminal size to the
 * child PTY. Called by the xterm.js fit addon whenever the dashboard
 * pane is resized so wrap behaves correctly inside the TUI.
 */
export async function POST(req: Request, ctx: RouteCtx): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const session = getSession(id);
  if (!session) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  let body: ResizeBody;
  try {
    body = (await req.json()) as ResizeBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const cols = typeof body.cols === "number" ? body.cols : undefined;
  const rows = typeof body.rows === "number" ? body.rows : undefined;
  if (cols == null || rows == null) {
    return NextResponse.json({ error: "missing_dimensions" }, { status: 400 });
  }
  session.resize(cols, rows);
  return NextResponse.json({ ok: true, cols: session.info.cols, rows: session.info.rows });
}
