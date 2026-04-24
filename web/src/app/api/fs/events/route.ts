import { NextResponse } from "next/server";
import * as fsSync from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isSessionAuthenticated } from "@/lib/auth/session";
import {
  classifyFsEvent,
  makeDebouncer,
  type FsEvent,
} from "@/lib/fs/watcher";
import {
  IGNORED_NAMES,
  isIgnoredRelPath,
  toRelative,
  WORKSPACE_ROOT,
} from "@/lib/fs/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/fs/events — SSE stream of workspace filesystem events.
 *
 * Each event is one of:
 *   { type: "add"|"change"|"unlink"|"addDir"|"unlinkDir", path }
 * with `path` being the same workspace-relative POSIX form returned
 * by `/api/fs/tree`.
 *
 * The watcher uses `node:fs.watch({ recursive: true })` (supported on
 * Linux since Node 20, and natively on macOS/Windows). Events are
 * coalesced through a 150ms per-path debouncer because `fs.watch` is
 * notoriously chatty (a single editor save commonly produces 2-3
 * raw events). Entries that the file tree already hides
 * (`node_modules`, `.git`, etc., plus dotfiles other than `.github`)
 * are dropped here too so the UI sees exactly the same surface.
 *
 * The session is *not* killed on client disconnect — the watcher is.
 * We tear down the underlying `fs.watch` and any pending debounce
 * timers when the request `AbortSignal` fires so we don't leak file
 * descriptors.
 */
export async function GET(req: Request): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const root = WORKSPACE_ROOT;
  const abortSignal = req.signal;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      // Remembers the last observed type at each relative path so
      // classifyFsEvent can distinguish "new file" from "change",
      // and "missing dir" from "missing file".
      const seen = new Map<string, "file" | "dir">();
      const debouncer = makeDebouncer(150);
      let watcher: fsSync.FSWatcher | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        const payload =
          `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          /* controller already closed */
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        debouncer.cancel();
        if (heartbeat) clearInterval(heartbeat);
        try {
          watcher?.close();
        } catch {
          /* ignore */
        }
        abortSignal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      const emit = (e: FsEvent) => {
        if (isIgnoredRelPath(e.path)) return;
        send("fs", e);
      };

      const probe = (relPath: string): "file" | "dir" | null => {
        // Sync `lstatSync` is intentional: the 150ms per-path
        // debouncer means we run this at most a few times per second
        // even under heavy filesystem churn, and the alternative
        // (async `lstat`) would let two ticks for the same path
        // race each other and corrupt the `seen` map.
        try {
          const abs = path.join(root, relPath);
          const st = fsSync.lstatSync(abs);
          if (st.isDirectory()) return "dir";
          if (st.isFile() || st.isSymbolicLink()) return "file";
          return null;
        } catch {
          return null;
        }
      };

      const handle = (rawRel: string | null) => {
        // `fs.watch` on Linux can emit `null` filenames when the root
        // itself changes; treat those as a no-op.
        if (rawRel === null || rawRel === "") return;
        const rel = rawRel.split(path.sep).join("/");
        if (isIgnoredRelPath(rel)) return;
        debouncer.schedule(rel, () => {
          const probed = probe(rel);
          const wasDir = seen.has(rel) ? seen.get(rel) === "dir" : null;
          const ev = classifyFsEvent(rel, probed, wasDir);
          if (probed === null) {
            seen.delete(rel);
          } else {
            seen.set(rel, probed);
          }
          if (ev) emit(ev);
        });
      };

      try {
        watcher = fsSync.watch(
          root,
          { recursive: true, persistent: false },
          (_eventType, filename) => {
            // `filename` is `string | null` for the default
            // (utf-8) encoding we're using; coerce defensively in
            // case Node ever hands us a Buffer.
            const rel =
              typeof filename === "string"
                ? filename
                : filename
                  ? String(filename)
                  : null;
            handle(rel);
          },
        );
        watcher.on("error", (err) => {
          send("error", { message: (err as Error).message });
        });
      } catch (err) {
        send("error", {
          message: `fs.watch failed: ${(err as Error).message}`,
        });
        close();
        return;
      }

      // Tell the client we're live. Includes the workspace root so
      // the UI can confirm it's wired to the right folder.
      send("ready", { root: toRelative(root) });

      // Heartbeat keeps proxies (and Cloudflare/edge timeouts) from
      // killing the SSE stream during long quiet periods.
      heartbeat = setInterval(() => send("ping", { t: Date.now() }), 25_000);
      (heartbeat as unknown as { unref?: () => void }).unref?.();

      abortSignal.addEventListener("abort", close);

      // Walk the tree once so the `seen` map knows about existing
      // entries; otherwise the very first event for a pre-existing
      // file would be misclassified as `add`.
      void primeSeen(root, seen);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Walk the workspace once after attaching the watcher so the
 * `seen` map knows about pre-existing entries. Bounded by the same
 * IGNORED_NAMES set so we don't traverse `node_modules`.
 */
async function primeSeen(
  root: string,
  seen: Map<string, "file" | "dir">,
): Promise<void> {
  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        seen.set(childRel, "dir");
        await walk(path.join(abs, entry.name), childRel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        seen.set(childRel, "file");
      }
    }
  };
  await walk(root, "");
}
