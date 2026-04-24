/**
 * Workspace root resolution + safe path joining.
 *
 * The dashboard exposes a filesystem and command-execution API rooted
 * at one of the configured workspaces (defaults to the gateway repo).
 * To prevent path traversal (`..`, absolute paths, symlinks pointing
 * outside the root), every API route MUST resolve user input through
 * `safeJoin()` before any fs operation.
 *
 * Multi-workspace callers should pass `{ root }` (e.g. the active
 * workspace from the runtime store) so the sanitiser anchors at the
 * right project. Without `{ root }`, `WORKSPACE_ROOT` (resolved at
 * module load from env) is used — preserved for backward
 * compatibility with existing call sites.
 */

import path from "node:path";
import { realpath } from "node:fs/promises";

import { readEnv } from "@/lib/env";

/**
 * Resolved at module load. We default to the parent of `process.cwd()`
 * because `next dev` / `next start` runs from `web/`. The
 * `CLAUDE_CODEX_WORKSPACE` env var (alias `MISSION_CONTROL_WORKSPACE`)
 * lets users override (useful in tests or when running the dashboard
 * from a different directory).
 *
 * The runtime can override on a per-call basis by passing `{ root }`
 * (see {@link safeJoin}); this constant is the env-derived fallback
 * and the seed value for the default workspace.
 */
export const WORKSPACE_ROOT = path.resolve(
  readEnv("CLAUDE_CODEX_WORKSPACE", "MISSION_CONTROL_WORKSPACE") ||
    path.join(process.cwd(), ".."),
);

/**
 * Look up the active workspace's root from the runtime store. Lazy
 * (and dynamically imported) to avoid a circular dependency with
 * `@/lib/runtime/store` and to keep the path-sanitiser usable from
 * code that has no opinion on the runtime — falling back to
 * `WORKSPACE_ROOT` if the store isn't loaded yet or the workspaces
 * list is empty.
 */
export async function getActiveWorkspaceRoot(): Promise<string> {
  try {
    const { getStore, activeWorkspace } = await import("@/lib/runtime/store");
    const snap = await getStore().snapshot();
    const ws = activeWorkspace(snap);
    if (ws && typeof ws.root === "string" && path.isAbsolute(ws.root)) {
      return path.resolve(ws.root);
    }
  } catch {
    /* ignore – fall through */
  }
  return WORKSPACE_ROOT;
}

/**
 * Strip a planner-supplied path of conventions that the planner
 * frequently emits but that confuse `safeJoin` (which insists on
 * relative paths). In particular: a leading `/workspace/` or a
 * leading copy of the active workspace root is harmless and the
 * planner means "from the workspace root" — accept it instead of
 * 400ing.
 *
 * Does NOT alter `..` segments — the actual containment check is
 * still performed by `safeJoin`. Pure helper, exported for tests.
 */
export function normaliseUserPath(input: string, root: string): string {
  if (typeof input !== "string") return "";
  let cleaned = input.replace(/\\/g, "/").trim();
  if (!cleaned) return "";
  // Strip a leading copy of the absolute workspace root.
  const rootPosix = root.replace(/\\/g, "/");
  if (cleaned === rootPosix) return "";
  if (cleaned.startsWith(rootPosix + "/")) {
    cleaned = cleaned.slice(rootPosix.length + 1);
  }
  // Strip the conventional `/workspace/` prefix that Docker users see.
  if (cleaned === "/workspace") return "";
  if (cleaned.startsWith("/workspace/")) cleaned = cleaned.slice("/workspace/".length);
  return cleaned;
}

export interface SafeJoinOptions {
  /** Explicit workspace root. Defaults to the env-derived `WORKSPACE_ROOT`. */
  root?: string;
}

/**
 * Resolve a user-supplied relative path inside the workspace root.
 *
 * Returns the absolute, normalised path or throws an Error whose
 * message is safe to surface to clients ("invalid path").
 *
 * Notes:
 *  - We refuse absolute inputs outright.
 *  - After joining + normalising we re-check that the result is still
 *    rooted at the workspace root (catches `..` segments).
 *  - We then `realpath()` the result so symlinks pointing outside the
 *    root are rejected too. If the file does not exist yet (e.g. the
 *    write endpoint creating a new file) we walk up to the nearest
 *    existing ancestor and realpath that, then re-check containment.
 */
export async function safeJoin(
  relative: string,
  opts: SafeJoinOptions = {},
): Promise<string> {
  const root = opts.root ? path.resolve(opts.root) : WORKSPACE_ROOT;
  if (typeof relative !== "string") throw new Error("invalid path");
  // Normalise Windows-style separators just in case.
  const cleaned = relative.replace(/\\/g, "/").trim();
  if (cleaned === "" || cleaned === "/") return root;
  if (path.isAbsolute(cleaned)) throw new Error("invalid path");

  const joined = path.resolve(root, cleaned);
  if (!isInside(root, joined)) throw new Error("invalid path");

  // Resolve symlinks where possible. For not-yet-existing paths,
  // realpath the nearest existing ancestor.
  let candidate = joined;
  for (;;) {
    try {
      const real = await realpath(candidate);
      const resolved =
        candidate === joined
          ? real
          : path.join(real, path.relative(candidate, joined));
      if (!isInside(root, resolved)) {
        throw new Error("invalid path");
      }
      return resolved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = path.dirname(candidate);
        if (parent === candidate) {
          // Walked up to the filesystem root without finding anything.
          throw new Error("invalid path");
        }
        candidate = parent;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Directory / file names that the dashboard's filesystem surface
 * (tree listing, real-time watcher, create/rename endpoints) refuses
 * to traffic in. These are noisy build outputs and VCS metadata that
 * the operator never wants to see, and watching them would flood the
 * SSE stream with churn from `next dev` rebuilds or `npm install`.
 *
 * Centralised here so the tree route, the SSE watcher and the
 * mutation endpoints all apply the same rule.
 */
export const IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "coverage",
]);

/**
 * True if a workspace-relative POSIX path traverses through an
 * ignored directory (or *is* an ignored entry). Pure helper —
 * exported for tests and reused by the SSE watcher to drop noisy
 * events without re-implementing the rule.
 */
export function isIgnoredRelPath(rel: string): boolean {
  if (typeof rel !== "string" || rel === "") return false;
  const segments = rel.split("/").filter((s) => s.length > 0);
  for (const seg of segments) {
    if (IGNORED_NAMES.has(seg)) return true;
    // Hidden entries are also hidden by the tree route (except .github);
    // mirror that here so create/watch behaviour matches what the user
    // sees in the explorer.
    if (seg.startsWith(".") && seg !== ".github") return true;
  }
  return false;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Convert an absolute workspace path back to a `/`-rooted relative path. */
export function toRelative(absolute: string, root: string = WORKSPACE_ROOT): string {
  const rel = path.relative(root, absolute);
  return rel === "" ? "/" : rel.split(path.sep).join("/");
}

/**
 * Belt-and-braces assertion: throw unless `absolute` is a fully
 * resolved path that lives inside the given root (defaults to the
 * env-derived `WORKSPACE_ROOT`). Call this immediately before any
 * `fs.*` operation that takes a user-derived path. This makes the
 * sanitizer obvious to humans and to static analyzers (CodeQL
 * js/path-injection).
 */
export function assertInsideWorkspace(
  absolute: string,
  root: string = WORKSPACE_ROOT,
): void {
  if (!path.isAbsolute(absolute) || !isInside(root, absolute)) {
    throw new Error("invalid path");
  }
}
