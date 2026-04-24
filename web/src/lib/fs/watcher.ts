/**
 * Filesystem-watch helpers shared by the SSE `/api/fs/events` route.
 *
 * Two responsibilities, kept separate so the pure logic can be unit
 * tested without touching the disk:
 *
 *  1. {@link classifyFsEvent} — given a workspace-relative path and a
 *     `Stats` lookup, classify a raw `fs.watch` notification into one
 *     of the high-level event kinds the client needs.
 *  2. {@link makeDebouncer} — coalesce a burst of events for the same
 *     path into a single emission. `fs.watch` is famously chatty
 *     (one logical save can produce several `change` events on Linux,
 *     and editors that write-then-rename emit `rename` followed by
 *     `change`), so we always wait a short quiet period before
 *     classifying.
 *
 * The route itself owns the actual `fs.watch` handle and the SSE
 * stream — see `web/src/app/api/fs/events/route.ts`.
 */

export type FsEventKind =
  | "add"
  | "change"
  | "unlink"
  | "addDir"
  | "unlinkDir";

export interface FsEvent {
  type: FsEventKind;
  /** Workspace-relative POSIX path. Empty string means workspace root. */
  path: string;
}

/**
 * Resolve a raw watcher tick (which only tells us "something at this
 * path"). Pure — takes a synchronous existence/type probe so callers
 * can inject the disk lookup (or a stub in tests).
 *
 * @param relPath workspace-relative POSIX path, or "" for the root
 * @param probe   returns `"file"`, `"dir"`, or `null` when missing
 * @param wasDir  what we last saw at this path (`null` if first time)
 */
export function classifyFsEvent(
  relPath: string,
  probe: "file" | "dir" | null,
  wasDir: boolean | null,
): FsEvent | null {
  if (probe === null) {
    // Path no longer exists. Pick the right unlink event based on
    // what we last saw there. If we never saw it, drop — there's
    // nothing for the client to remove.
    if (wasDir === null) return null;
    return { type: wasDir ? "unlinkDir" : "unlink", path: relPath };
  }
  if (probe === "dir") {
    // First time we see it as a directory → addDir. Otherwise the
    // dir's mtime/contents changed; the client will re-list lazily,
    // so we don't fire a `change` for dirs.
    if (wasDir === true) return null;
    return { type: "addDir", path: relPath };
  }
  // It's a file.
  if (wasDir === null) return { type: "add", path: relPath };
  if (wasDir === true) {
    // Replaced a directory with a file at the same path. Treat as
    // unlinkDir + add so the client can drop the dir subtree.
    return { type: "add", path: relPath };
  }
  return { type: "change", path: relPath };
}

/**
 * A tiny per-key debouncer. Calling `schedule(key, fn)` arms a timer;
 * subsequent calls before `delayMs` elapses replace the pending fn,
 * so a rapid burst of events for one path fires the callback exactly
 * once after the burst quiets down.
 *
 * Why per-key (rather than a single global timer)? Two unrelated
 * file changes shouldn't delay each other; a tight loop saving file
 * A shouldn't push file B's notification arbitrarily far into the
 * future.
 *
 * Returns a `cancel()` to clear all pending timers when the watcher
 * is being torn down (SSE client disconnect, route unmount).
 */
export function makeDebouncer(delayMs: number): {
  schedule(key: string, fn: () => void): void;
  cancel(): void;
  pendingCount(): number;
} {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    schedule(key, fn) {
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        timers.delete(key);
        try {
          fn();
        } catch {
          /* swallow — caller logs as appropriate */
        }
      }, delayMs);
      // Don't keep the Node process alive purely for a debounce timer
      // — if the route is being torn down we want the process to exit.
      (t as unknown as { unref?: () => void }).unref?.();
      timers.set(key, t);
    },
    cancel() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
    pendingCount() {
      return timers.size;
    },
  };
}
