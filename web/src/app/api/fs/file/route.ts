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

const MAX_FILE_BYTES = 1_500_000; // 1.5 MB — Monaco gets unhappy past this.

interface PutBody {
  path?: unknown;
  content?: unknown;
}

interface CreateBody {
  path?: unknown;
  /** Optional initial content for a brand-new file. Defaults to "". */
  content?: unknown;
}

interface DeleteBody {
  path?: unknown;
}

/** GET /api/fs/file?path=relative — return UTF-8 text. */
export async function GET(req: Request): Promise<NextResponse> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const rel = url.searchParams.get("path");
  if (!rel) {
    return NextResponse.json({ error: "missing_path" }, { status: 400 });
  }
  let abs: string;
  try {
    abs = await safeJoin(rel);
    assertInsideWorkspace(abs);
  } catch {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "not_a_file" }, { status: 400 });
    }
    if (stat.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: "file_too_large", size: stat.size, max: MAX_FILE_BYTES },
        { status: 413 },
      );
    }
    const content = await fs.readFile(abs, "utf8");
    return NextResponse.json({
      path: rel,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      content,
      language: detectLanguage(rel),
    });
  } catch {
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }
}

/**
 * POST /api/fs/file — body: `{ path, content? }`. Creates a brand-new
 * file. Refuses to overwrite an existing file (use PUT for that) and
 * refuses to create files inside ignored locations
 * (`node_modules`, `.git`, etc.) so the dashboard's create surface
 * matches what the explorer is willing to show.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (typeof body.path !== "string" || body.path.trim() === "") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content : "";
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "content_too_large" }, { status: 413 });
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
    // Create any intermediate directories so the operator can create
    // "src/lib/foo/new.ts" in one step. The `wx` flag below is
    // atomic: it fails with EEXIST if the file already exists, which
    // we surface as 409. We deliberately *don't* pre-stat the file —
    // that would introduce a TOCTOU race window between the check
    // and the write. The `wx` open flag is the correct primitive.
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, { encoding: "utf8", flag: "wx" });
    const stat = await fs.stat(abs);
    return NextResponse.json(
      { path: body.path, size: stat.size, mtimeMs: stat.mtimeMs },
      { status: 201 },
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return NextResponse.json({ error: "already_exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "write_failed" }, { status: 500 });
  }
}

/** PUT /api/fs/file — body: { path, content } — overwrites existing file. */
export async function PUT(req: Request): Promise<NextResponse> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (typeof body.path !== "string" || typeof body.content !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (Buffer.byteLength(body.content, "utf8") > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "content_too_large" }, { status: 413 });
  }
  let abs: string;
  try {
    abs = await safeJoin(body.path);
    assertInsideWorkspace(abs);
  } catch {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }
  try {
    // Refuse to create new files via PUT — that's POST's job. Keeps
    // a clear separation between "edit existing" and "create new"
    // and prevents accidental writes to unexpected locations.
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) {
      return NextResponse.json({ error: "not_a_file" }, { status: 400 });
    }
    await fs.writeFile(abs, body.content, "utf8");
    const newStat = await fs.stat(abs);
    return NextResponse.json({
      path: body.path,
      size: newStat.size,
      mtimeMs: newStat.mtimeMs,
    });
  } catch {
    return NextResponse.json({ error: "write_failed" }, { status: 500 });
  }
}

/**
 * DELETE /api/fs/file — body: `{ path }`. Removes a single file
 * (never a directory — use `/api/fs/dir` for that). Refuses to
 * delete inside ignored locations so the operator can't nuke
 * `.git/HEAD` from the UI.
 */
export async function DELETE(req: Request): Promise<NextResponse> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
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
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (!stat.isFile()) {
      return NextResponse.json({ error: "not_a_file" }, { status: 400 });
    }
    await fs.unlink(abs);
    return NextResponse.json({ ok: true, path: body.path });
  } catch {
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
}

function detectLanguage(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
    case ".mdx":
      return "markdown";
    case ".css":
      return "css";
    case ".html":
      return "html";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".sh":
      return "shell";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    default:
      return "plaintext";
  }
}
