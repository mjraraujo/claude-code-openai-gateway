import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isSessionAuthenticated } from "@/lib/auth/session";
import {
  assertInsideWorkspace,
  safeJoin,
  toRelative,
  WORKSPACE_ROOT,
} from "@/lib/fs/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  children?: TreeNode[];
}

const IGNORE = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "coverage",
]);

const MAX_DEPTH = 4;
const MAX_ENTRIES_PER_DIR = 200;

/**
 * GET /api/fs/tree?path=relative/path
 *
 * Returns a depth-limited directory tree below the given path
 * (defaults to workspace root). Hidden entries and common build
 * directories are filtered out.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const rel = url.searchParams.get("path") ?? "";
  let abs: string;
  try {
    abs = await safeJoin(rel);
    assertInsideWorkspace(abs);
  } catch {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }

  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "not_a_directory" }, { status: 400 });
    }
    const tree = await walk(abs, 0);
    return NextResponse.json({
      root: toRelative(WORKSPACE_ROOT),
      tree,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { error: "read_failed", message },
      { status: 500 },
    );
  }
}

async function walk(dir: string, depth: number): Promise<TreeNode[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries = entries
    .filter((e) => !e.name.startsWith(".") || e.name === ".github")
    .filter((e) => !IGNORE.has(e.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_ENTRIES_PER_DIR);

  const out: TreeNode[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    // `dir` was validated by the caller; entry.name comes from
    // readdir on a validated dir, but assert before any further
    // recursion to keep the sanitizer obvious.
    try {
      assertInsideWorkspace(abs);
    } catch {
      continue;
    }
    const rel = toRelative(abs);
    if (entry.isDirectory()) {
      const node: TreeNode = { name: entry.name, path: rel, type: "dir" };
      if (depth < MAX_DEPTH) {
        node.children = await walk(abs, depth + 1);
      }
      out.push(node);
    } else if (entry.isFile()) {
      out.push({ name: entry.name, path: rel, type: "file" });
    }
  }
  return out;
}
