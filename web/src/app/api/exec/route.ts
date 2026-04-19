import { spawn } from "node:child_process";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { WORKSPACE_ROOT } from "@/lib/fs/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/exec  body: { command: string, cwd?: string }
 *
 * Streams stdout / stderr / exit events as Server-Sent Events. Used
 * by the Mission Control "Terminal" tab as a real but non-interactive
 * shell — perfect for `npm test`, `git status`, build commands, etc.
 *
 * Why SSE instead of a true PTY?
 *   - Avoids `node-pty`'s native build step (won't compile in some
 *     sandboxes) and a custom Next.js server.
 *   - One-way stream maps cleanly onto an HTTP response — no
 *     WebSocket plumbing needed.
 *
 * Future: a `node-pty`-backed `/api/pty` WebSocket can be added
 * alongside this route when we ship the desktop builds.
 */

/**
 * Defensive blocklist for obviously catastrophic commands. This is
 * NOT a security boundary — `bash -lc` is fully expressive and
 * trivially bypassed (e.g. `eval "$(echo cm0gLXJmIC8K | base64 -d)"`).
 * Authentication via the session cookie is the actual access control;
 * this list is only here to catch fat-finger accidents.
 */
const BLOCKED_COMMAND_PATTERNS = [
  "rm -rf /",
  "sudo ",
  ":(){",
  "mkfs",
  "shutdown",
  "reboot",
  "dd if=",
];

const MAX_DURATION_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MB cap per run

interface ExecBody {
  command?: unknown;
  cwd?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: ExecBody;
  try {
    body = (await req.json()) as ExecBody;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (!command) {
    return new Response(JSON.stringify({ error: "missing_command" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  for (const bad of BLOCKED_COMMAND_PATTERNS) {
    if (command.includes(bad)) {
      return new Response(JSON.stringify({ error: "command_blocked" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const cwd = WORKSPACE_ROOT;
  const abortSignal = req.signal;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let bytes = 0;
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        const payload =
          `event: ${event}\n` +
          `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      send("start", { command, cwd });

      // Run via `bash -lc` so users can use shell features (pipes,
      // env vars, etc.) without us reimplementing parsing.
      const child = spawn("bash", ["-lc", command], {
        cwd,
        env: { ...process.env, FORCE_COLOR: "1", TERM: "xterm-256color" },
      });

      const timeout = setTimeout(() => {
        send("info", { message: "timeout — killing process" });
        child.kill("SIGKILL");
      }, MAX_DURATION_MS);

      const onAbort = () => {
        send("info", { message: "client disconnected — killing process" });
        child.kill("SIGKILL");
      };
      abortSignal.addEventListener("abort", onAbort);

      const forward = (
        stream: NodeJS.ReadableStream | null,
        eventName: "stdout" | "stderr",
      ) => {
        if (!stream) return;
        stream.on("data", (chunk: Buffer) => {
          if (bytes >= MAX_OUTPUT_BYTES) return;
          const remaining = MAX_OUTPUT_BYTES - bytes;
          const slice =
            chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          bytes += slice.length;
          send(eventName, { chunk: slice.toString("utf8") });
          if (bytes >= MAX_OUTPUT_BYTES) {
            send("info", { message: "output limit reached — truncating" });
          }
        });
      };

      forward(child.stdout, "stdout");
      forward(child.stderr, "stderr");

      child.on("error", (err) => {
        send("error", { message: err.message });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        abortSignal.removeEventListener("abort", onAbort);
        send("exit", { code, signal });
        close();
      });
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
