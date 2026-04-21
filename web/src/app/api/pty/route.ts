import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { buildSpawnOptions, type PtyKind } from "@/lib/pty/policy";
import {
  createSession,
  listSessions,
  startReaperOnce,
} from "@/lib/pty/sessionManager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateBody {
  kind?: unknown;
  cols?: unknown;
  rows?: unknown;
}

function isValidKind(value: unknown): value is PtyKind {
  return value === "claude" || value === "shell";
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 ? n : undefined;
}

/**
 * POST /api/pty — create a PTY session.
 *
 * Body: `{ kind: "claude" | "shell", cols?: number, rows?: number }`.
 *
 * On success returns the session info including `id`. The id is
 * required by every subsequent route (`stream`, `input`, `resize`,
 * `DELETE /api/pty/[id]`).
 *
 * Auth: gated on the dashboard session cookie (same surface as
 * `/api/exec`), since a PTY hands out arbitrary command execution.
 */
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
  const kind: PtyKind = isValidKind(body.kind) ? body.kind : "claude";
  const cols = asPositiveInt(body.cols);
  const rows = asPositiveInt(body.rows);

  startReaperOnce();
  const opts = await buildSpawnOptions(kind, cols, rows);
  const result = createSession(opts);
  if (!result.ok) {
    const status =
      result.error === "limit"
        ? 429
        : result.error === "unsupported"
          ? 501
          : 500;
    return NextResponse.json(
      { error: result.error, detail: result.detail ?? null, kind },
      { status },
    );
  }
  return NextResponse.json({ session: result.info, kind });
}

/**
 * GET /api/pty — list active sessions. Cheap diagnostic for the UI.
 */
export async function GET(): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ sessions: listSessions() });
}
