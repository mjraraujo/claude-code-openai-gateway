/**
 * Workspaces CRUD.
 *
 * The dashboard supports N workspaces and one is "active" — every
 * fs/exec/chat-tool call resolves against the active workspace's
 * root. This collection-level route handles list + create; the
 * `[id]/route.ts` sibling handles update + delete + activate.
 *
 * GET   → { workspaces: Workspace[], activeWorkspaceId }
 * POST  body: { name, root? } — creates a workspace. When `root` is
 *       omitted the server creates a fresh directory under
 *       `WORKSPACES_PARENT_DIR` (default `~/codex-workspaces/`,
 *       configurable via `CLAUDE_CODEX_WORKSPACES_DIR`). When `root`
 *       is supplied it must be an absolute path the dashboard can
 *       both read and write.
 */

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isSessionAuthenticated } from "@/lib/auth/session";
import {
  getStore,
  MAX_WORKSPACE_NAME,
  MAX_WORKSPACES,
  newId,
  WORKSPACES_PARENT_DIR,
  type Workspace,
} from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

interface CreateBody {
  name?: unknown;
  /** Optional explicit absolute path. When omitted, server creates `${WORKSPACES_PARENT_DIR}/<name>`. */
  root?: unknown;
  /** When true, immediately switch the active workspace to the new one. Default false. */
  activate?: unknown;
}

export async function GET(): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const snap = await getStore().snapshot();
  return NextResponse.json({
    workspaces: snap.workspaces,
    activeWorkspaceId: snap.activeWorkspaceId,
  });
}

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
  const name =
    typeof body.name === "string" ? body.name.trim().slice(0, MAX_WORKSPACE_NAME) : "";
  if (!name) {
    return NextResponse.json({ error: "missing_name" }, { status: 400 });
  }
  // Generate a slug-shaped id from the name so the URL/UI is
  // human-readable. The trailing `||` fallback covers two cases:
  //   - the name contained only non-[a-z0-9] characters (slug = "")
  //   - the slug failed the id-shape regex
  // Either way we fall back to a server-side random id so the
  // workspace can still be created.
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  let id = slug && ID_RE.test(slug) ? slug : newId("w");

  // Resolve root: explicit absolute path, or a fresh dir under the
  // parent. Either way the directory must exist (we'll create it).
  let root: string;
  if (typeof body.root === "string" && body.root) {
    if (!path.isAbsolute(body.root)) {
      return NextResponse.json({ error: "root_must_be_absolute" }, { status: 400 });
    }
    root = path.resolve(body.root);
  } else {
    root = path.resolve(WORKSPACES_PARENT_DIR, id);
  }

  // Create the directory if it doesn't exist. `recursive: true`
  // makes this idempotent and creates intermediates. We tolerate
  // EEXIST because users may want to register an existing folder.
  try {
    await fs.mkdir(root, { recursive: true });
  } catch (err) {
    return NextResponse.json(
      { error: "mkdir_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  const activate = body.activate === true;

  let conflict: "id" | "root" | null = null;
  let limited = false;
  const next = await getStore().update((draft) => {
    if (draft.workspaces.length >= MAX_WORKSPACES) {
      limited = true;
      return;
    }
    // Disambiguate id collisions with a numeric suffix.
    if (draft.workspaces.some((w) => w.id === id)) {
      let n = 2;
      while (draft.workspaces.some((w) => w.id === `${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    if (draft.workspaces.some((w) => w.root === root)) {
      conflict = "root";
      return;
    }
    const ws: Workspace = { id, name, root, createdAt: Date.now() };
    draft.workspaces.push(ws);
    if (activate) draft.activeWorkspaceId = ws.id;
  });
  if (limited) {
    return NextResponse.json({ error: "workspace_limit_reached" }, { status: 400 });
  }
  if (conflict) {
    return NextResponse.json({ error: "duplicate_root" }, { status: 409 });
  }
  return NextResponse.json({
    workspaces: next.workspaces,
    activeWorkspaceId: next.activeWorkspaceId,
  });
}
