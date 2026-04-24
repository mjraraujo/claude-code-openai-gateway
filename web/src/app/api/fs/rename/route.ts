import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isSessionAuthenticated } from "@/lib/auth/session";
import {
  assertInsideWorkspace,
  isIgnoredRelPath,
  safeJoin,
} from "@/lib/fs/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RenameBody {
  from?: unknown;
  to?: unknown;
}

/**
 * POST /api/fs/rename — body: `{ from, to }`. Rename / move a file
 * or directory. Both endpoints must resolve inside the workspace
 * and outside the IGNORE list. Refuses to overwrite an existing
 * destination so a typo can't silently clobber data.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: RenameBody;
  try {
    body = (await req.json()) as RenameBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (
    typeof body.from !== "string" ||
    typeof body.to !== "string" ||
    body.from.trim() === "" ||
    body.to.trim() === ""
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (isIgnoredRelPath(body.from) || isIgnoredRelPath(body.to)) {
    return NextResponse.json({ error: "ignored_path" }, { status: 400 });
  }
  let absFrom: string;
  let absTo: string;
  try {
    absFrom = await safeJoin(body.from);
    absTo = await safeJoin(body.to);
    assertInsideWorkspace(absFrom);
    assertInsideWorkspace(absTo);
  } catch {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }
  if (absFrom === absTo) {
    return NextResponse.json({ ok: true, from: body.from, to: body.to });
  }
  try {
    const fromStat = await fs.stat(absFrom).catch(() => null);
    if (!fromStat) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const toStat = await fs.stat(absTo).catch(() => null);
    if (toStat) {
      return NextResponse.json({ error: "already_exists" }, { status: 409 });
    }
    // Make sure the destination's parent exists so renaming
    // "a.txt" -> "newdir/a.txt" works in one shot.
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.rename(absFrom, absTo);
    return NextResponse.json({ ok: true, from: body.from, to: body.to });
  } catch {
    return NextResponse.json({ error: "rename_failed" }, { status: 500 });
  }
}
