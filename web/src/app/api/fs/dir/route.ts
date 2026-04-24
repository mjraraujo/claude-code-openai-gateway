import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";

import { isSessionAuthenticated } from "@/lib/auth/session";
import {
  assertInsideWorkspace,
  isIgnoredRelPath,
  safeJoin,
} from "@/lib/fs/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MkdirBody {
  path?: unknown;
}

interface RmdirBody {
  path?: unknown;
  recursive?: unknown;
}

/**
 * POST /api/fs/dir — body: `{ path }`. Create a directory (with any
 * intermediate parents). Idempotent — if the directory already
 * exists we return 200 OK rather than 409 because the caller's
 * intent ("ensure this dir exists") is already satisfied. Refuses
 * to create inside ignored locations.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: MkdirBody;
  try {
    body = (await req.json()) as MkdirBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (typeof body.path !== "string" || body.path.trim() === "") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (isIgnoredRelPath(body.path)) {
    return NextResponse.json({ error: "ignored_path" }, { status: 400 });
  }
  let abs: string;
  try {
    abs = await safeJoin(body.path);
    assertInsideWorkspace(abs);
  } catch {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }
  try {
    const existing = await fs.stat(abs).catch(() => null);
    if (existing) {
      if (!existing.isDirectory()) {
        return NextResponse.json({ error: "not_a_directory" }, { status: 409 });
      }
      return NextResponse.json({ ok: true, path: body.path, created: false });
    }
    await fs.mkdir(abs, { recursive: true });
    return NextResponse.json(
      { ok: true, path: body.path, created: true },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: "mkdir_failed" }, { status: 500 });
  }
}

/**
 * DELETE /api/fs/dir — body: `{ path, recursive? }`. Remove a
 * directory. By default refuses to delete a non-empty directory;
 * pass `recursive: true` explicitly to nuke a subtree. Refuses to
 * delete ignored locations and the workspace root itself.
 */
export async function DELETE(req: Request): Promise<NextResponse> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: RmdirBody;
  try {
    body = (await req.json()) as RmdirBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (typeof body.path !== "string" || body.path.trim() === "") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (isIgnoredRelPath(body.path)) {
    return NextResponse.json({ error: "ignored_path" }, { status: 400 });
  }
  // Empty / "/" / all-slashes inputs would resolve to the workspace
  // root — never OK. Done with character-walking rather than a regex
  // to avoid polynomial backtracking on pathological "////..." input.
  let trimStart = 0;
  while (trimStart < body.path.length && body.path.charCodeAt(trimStart) === 47) {
    trimStart++;
  }
  let trimEnd = body.path.length;
  while (trimEnd > trimStart && body.path.charCodeAt(trimEnd - 1) === 47) {
    trimEnd--;
  }
  if (trimStart >= trimEnd) {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }
  const recursive = body.recursive === true;
  let abs: string;
  try {
    abs = await safeJoin(body.path);
    assertInsideWorkspace(abs);
  } catch {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }
  try {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "not_a_directory" }, { status: 400 });
    }
    if (recursive) {
      await fs.rm(abs, { recursive: true, force: false });
    } else {
      // `rmdir` fails with ENOTEMPTY for non-empty dirs — surface
      // that as a 409 so the client can prompt for confirmation
      // before retrying with `recursive: true`.
      try {
        await fs.rmdir(abs);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOTEMPTY" || code === "EEXIST") {
          return NextResponse.json(
            { error: "not_empty" },
            { status: 409 },
          );
        }
        throw err;
      }
    }
    return NextResponse.json({ ok: true, path: body.path });
  } catch {
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
}
