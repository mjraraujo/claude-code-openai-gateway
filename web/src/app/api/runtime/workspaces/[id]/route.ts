/**
 * Per-workspace operations: rename, change root, delete, and the
 * "switch active" verb.
 *
 * PATCH /api/runtime/workspaces/[id]
 *   body: { name?, root?, activate? }
 *     - name      : rename
 *     - root      : re-anchor (absolute path; must exist)
 *     - activate  : switch the dashboard's active workspace to this id
 *
 * DELETE /api/runtime/workspaces/[id]
 *   Refuses to delete the last remaining workspace. If the deleted
 *   workspace was active, the active id falls back to the first
 *   remaining workspace so the dashboard keeps a coherent root.
 *   Files on disk are NEVER deleted — this is a registry op only.
 */

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getStore, MAX_WORKSPACE_NAME } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchBody {
  name?: unknown;
  root?: unknown;
  activate?: unknown;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // If the caller is changing the root, validate the new path
  // exists on disk before mutating state. Done outside the update
  // closure because it's async and the closure runs synchronously.
  let newRoot: string | undefined;
  if (typeof body.root === "string" && body.root) {
    if (!path.isAbsolute(body.root)) {
      return NextResponse.json({ error: "root_must_be_absolute" }, { status: 400 });
    }
    newRoot = path.resolve(body.root);
    try {
      const stat = await fs.stat(newRoot);
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: "root_not_a_directory" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "root_does_not_exist" }, { status: 400 });
    }
  }

  let found = false;
  let conflict = false;
  const next = await getStore().update((draft) => {
    const ws = draft.workspaces.find((w) => w.id === id);
    if (!ws) return;
    found = true;
    if (typeof body.name === "string" && body.name.trim()) {
      ws.name = body.name.trim().slice(0, MAX_WORKSPACE_NAME);
    }
    if (newRoot) {
      if (draft.workspaces.some((w) => w.id !== id && w.root === newRoot)) {
        conflict = true;
        return;
      }
      ws.root = newRoot;
    }
    if (body.activate === true) {
      draft.activeWorkspaceId = id;
    }
  });
  if (!found) {
    return NextResponse.json({ error: "workspace_not_found" }, { status: 404 });
  }
  if (conflict) {
    return NextResponse.json({ error: "duplicate_root" }, { status: 409 });
  }
  return NextResponse.json({
    workspaces: next.workspaces,
    activeWorkspaceId: next.activeWorkspaceId,
  });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  let removed = false;
  let lastOne = false;
  const next = await getStore().update((draft) => {
    if (draft.workspaces.length <= 1) {
      lastOne = true;
      return;
    }
    const idx = draft.workspaces.findIndex((w) => w.id === id);
    if (idx < 0) return;
    removed = true;
    draft.workspaces.splice(idx, 1);
    if (draft.activeWorkspaceId === id) {
      draft.activeWorkspaceId = draft.workspaces[0].id;
    }
    // Drop any scaffolding records that referenced this workspace.
    draft.scaffolds = draft.scaffolds.filter((s) => s.workspaceId !== id);
  });
  if (lastOne) {
    return NextResponse.json({ error: "cannot_delete_last_workspace" }, { status: 400 });
  }
  if (!removed) {
    return NextResponse.json({ error: "workspace_not_found" }, { status: 404 });
  }
  return NextResponse.json({
    workspaces: next.workspaces,
    activeWorkspaceId: next.activeWorkspaceId,
  });
}
