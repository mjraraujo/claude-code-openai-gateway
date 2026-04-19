import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { startAutoDrive, stopAutoDrive } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  action?: unknown;
  goal?: unknown;
  maxSteps?: unknown;
  maxWallMs?: unknown;
  maxBytes?: unknown;
}

/**
 * POST /api/runtime/auto-drive  body: { action: "start" | "stop", goal?, maxSteps? }
 *
 * Starting returns the new run record; stopping is idempotent and
 * returns 200 even if no run was active.
 */
export async function POST(req: Request): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const action = body.action === "stop" ? "stop" : body.action === "start" ? "start" : null;
  if (!action) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  if (action === "stop") {
    await stopAutoDrive("stopped by user");
    return NextResponse.json({ ok: true });
  }

  const goal = typeof body.goal === "string" ? body.goal : "";
  if (!goal.trim()) {
    return NextResponse.json({ error: "missing_goal" }, { status: 400 });
  }
  try {
    const run = await startAutoDrive({
      goal,
      maxSteps: numberOrUndef(body.maxSteps),
      maxWallMs: numberOrUndef(body.maxWallMs),
      maxBytes: numberOrUndef(body.maxBytes),
    });
    return NextResponse.json({ run });
  } catch (err) {
    const msg = (err as Error).message;
    const code = msg === "auto_drive_already_running" ? 409 : 400;
    return NextResponse.json({ error: msg }, { status: code });
  }
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
