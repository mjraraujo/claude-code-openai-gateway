import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import {
  forceClearAutoDrive,
  getStore,
  isValidDriveMode,
  startAutoDrive,
  stopAutoDrive,
  type DriveMode,
} from "@/lib/runtime";
import {
  startEndlessDrive,
  stopEndlessDrive,
} from "@/lib/runtime/drive-v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  action?: unknown;
  goal?: unknown;
  maxSteps?: unknown;
  maxWallMs?: unknown;
  maxBytes?: unknown;
  model?: unknown;
  /**
   * Optional override of the operator's persisted default. When
   * omitted, the route reads `harness.driveMode` from the store.
   */
  driveMode?: unknown;
}

/**
 * POST /api/runtime/auto-drive  body: { action: "start" | "stop" | "force-stop", goal?, maxSteps?, driveMode? }
 *
 * `driveMode` selects between the bounded one-shot engine
 * (`drive.ts`) and the endless multi-agent SDLC engine
 * (`drive-v2.ts`). Stop / force-stop hit both engines so the kill
 * switch in the UI works regardless of which one is running.
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
  const action =
    body.action === "stop"
      ? "stop"
      : body.action === "start"
        ? "start"
        : body.action === "force-stop"
          ? "force-stop"
          : null;
  if (!action) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  if (action === "stop") {
    // Idempotent across both engines — the one that isn't running
    // simply no-ops.
    await Promise.all([
      stopAutoDrive("stopped by user"),
      stopEndlessDrive("stopped by user"),
    ]);
    return NextResponse.json({ ok: true });
  }
  if (action === "force-stop") {
    await forceClearAutoDrive("force-cleared by user");
    await stopEndlessDrive("force-cleared by user");
    return NextResponse.json({ ok: true });
  }

  const goal = typeof body.goal === "string" ? body.goal : "";
  if (!goal.trim()) {
    return NextResponse.json({ error: "missing_goal" }, { status: 400 });
  }

  // Resolve drive mode: explicit override → persisted harness default
  // → "bounded".
  let mode: DriveMode = "bounded";
  if (isValidDriveMode(body.driveMode)) {
    mode = body.driveMode;
  } else {
    const snap = await getStore().snapshot();
    mode = snap.harness.driveMode ?? "bounded";
  }

  // Cross-engine guard: refuse to start if the other engine has a
  // run in flight. Both engines also enforce their own singleton via
  // a module-level flag, but the persisted `autoDrive.current` is the
  // canonical "is there a run" signal the UI watches.
  const snap = await getStore().snapshot();
  if (snap.autoDrive.current) {
    return NextResponse.json(
      { error: "auto_drive_already_running" },
      { status: 409 },
    );
  }

  try {
    const model =
      typeof body.model === "string" && body.model.trim() ? body.model : undefined;
    if (mode === "endless") {
      const run = await startEndlessDrive({ goal, model });
      return NextResponse.json({ run, mode });
    }
    const run = await startAutoDrive({
      goal,
      maxSteps: numberOrUndef(body.maxSteps),
      maxWallMs: numberOrUndef(body.maxWallMs),
      maxBytes: numberOrUndef(body.maxBytes),
      model,
    });
    return NextResponse.json({ run, mode });
  } catch (err) {
    const msg = (err as Error).message;
    const code = msg === "auto_drive_already_running" ? 409 : 400;
    return NextResponse.json({ error: msg }, { status: code });
  }
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
