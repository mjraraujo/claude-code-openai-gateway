/**
 * Workspace root resolution + safe path joining.
 *
 * The dashboard exposes a filesystem and command-execution API rooted
 * at the gateway repository (the parent of `web/`). To prevent path
 * traversal (`..`, absolute paths, symlinks pointing outside the
 * root), every API route MUST resolve user input through
 * `safeJoin()` before any fs operation.
 */

import path from "node:path";
import { realpath } from "node:fs/promises";

/**
 * Resolved at module load. We default to the parent of `process.cwd()`
 * because `next dev` / `next start` runs from `web/`. The
 * `MISSION_CONTROL_WORKSPACE` env var lets users override (useful in
 * tests or when running the dashboard from a different directory).
 */
export const WORKSPACE_ROOT = path.resolve(
  process.env.MISSION_CONTROL_WORKSPACE || path.join(process.cwd(), ".."),
);

/**
 * Resolve a user-supplied relative path inside `WORKSPACE_ROOT`.
 *
 * Returns the absolute, normalised path or throws an Error whose
 * message is safe to surface to clients ("invalid path").
 *
 * Notes:
 *  - We refuse absolute inputs outright.
 *  - After joining + normalising we re-check that the result is still
 *    rooted at `WORKSPACE_ROOT` (catches `..` segments).
 *  - We then `realpath()` the result so symlinks pointing outside the
 *    root are rejected too. If the file does not exist yet (e.g. the
 *    write endpoint creating a new file) we walk up to the nearest
 *    existing ancestor and realpath that, then re-check containment.
 */
export async function safeJoin(relative: string): Promise<string> {
  if (typeof relative !== "string") throw new Error("invalid path");
  // Normalise Windows-style separators just in case.
  const cleaned = relative.replace(/\\/g, "/").trim();
  if (cleaned === "" || cleaned === "/") return WORKSPACE_ROOT;
  if (path.isAbsolute(cleaned)) throw new Error("invalid path");

  const joined = path.resolve(WORKSPACE_ROOT, cleaned);
  if (!isInside(WORKSPACE_ROOT, joined)) throw new Error("invalid path");

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
      if (!isInside(WORKSPACE_ROOT, resolved)) {
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

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Convert an absolute workspace path back to a `/`-rooted relative path. */
export function toRelative(absolute: string): string {
  const rel = path.relative(WORKSPACE_ROOT, absolute);
  return rel === "" ? "/" : rel.split(path.sep).join("/");
}

/**
 * Belt-and-braces assertion: throw unless `absolute` is a fully
 * resolved path that lives inside `WORKSPACE_ROOT`. Call this
 * immediately before any `fs.*` operation that takes a user-derived
 * path. This makes the sanitizer obvious to humans and to static
 * analyzers (CodeQL js/path-injection).
 */
export function assertInsideWorkspace(absolute: string): void {
  if (!path.isAbsolute(absolute) || !isInside(WORKSPACE_ROOT, absolute)) {
    throw new Error("invalid path");
  }
}
