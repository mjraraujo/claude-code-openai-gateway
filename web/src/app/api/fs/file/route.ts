import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { assertInsideWorkspace, safeJoin } from "@/lib/fs/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 1_500_000; // 1.5 MB — Monaco gets unhappy past this.

interface PutBody {
  path?: unknown;
  content?: unknown;
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
      content,
      language: detectLanguage(rel),
    });
  } catch {
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
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
    // Refuse to create new files for now — must edit an existing one.
    // This keeps the surface area small and prevents accidental writes
    // to unexpected locations.
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) {
      return NextResponse.json({ error: "not_a_file" }, { status: 400 });
    }
    await fs.writeFile(abs, body.content, "utf8");
    const newStat = await fs.stat(abs);
    return NextResponse.json({ path: body.path, size: newStat.size });
  } catch {
    return NextResponse.json({ error: "write_failed" }, { status: 500 });
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
