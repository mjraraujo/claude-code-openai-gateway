import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getSession } from "@/lib/pty/sessionManager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface InputBody {
  data?: unknown;
}

/** Cap a single POST body so a runaway producer can't blow up RAM. */
const MAX_INPUT_BYTES = 64 * 1024;

/**
 * POST /api/pty/[id]/input — write to PTY stdin.
 *
 * Body: `{ data: string }`. Both bytes-as-utf8 and ANSI control
 * sequences (e.g. arrow keys, Ctrl+C) are accepted as raw strings
 * — xterm.js's `onData` already encodes them correctly.
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
  if (session.info.exited) {
    return NextResponse.json({ error: "exited" }, { status: 410 });
  }
  let body: InputBody;
  try {
    body = (await req.json()) as InputBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (typeof body.data !== "string") {
    return NextResponse.json({ error: "missing_data" }, { status: 400 });
  }
  if (Buffer.byteLength(body.data, "utf8") > MAX_INPUT_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  session.write(body.data);
  return NextResponse.json({ ok: true });
}
