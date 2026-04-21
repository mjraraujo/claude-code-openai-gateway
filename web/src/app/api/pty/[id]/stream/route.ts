import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getSession } from "@/lib/pty/sessionManager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/pty/[id]/stream — SSE stream of PTY output.
 *
 * Replays the current scrollback as a single `init` event so the
 * client can attach mid-session and immediately see what's already
 * on screen. After that emits an `out` event per chunk and an
 * `exit` event when the PTY exits.
 *
 * The stream stays open until either (a) the PTY exits, or (b) the
 * client disconnects. The session itself is *not* killed on client
 * disconnect — operators can reattach by re-opening the stream.
 * Unattended sessions are reaped by the idle timer in `sessionManager`.
 */
export async function GET(req: Request, ctx: RouteCtx): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const session = getSession(id);
  if (!session) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const abortSignal = req.signal;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

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
        session.detachListener();
        session.removeListener("data", onData);
        session.removeListener("exit", onExit);
        abortSignal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      const onData = (chunk: string) => send("out", { chunk });
      const onExit = (e: { code: number; signal?: number }) => {
        send("exit", e);
        close();
      };
      const onAbort = () => close();

      // Replay scrollback first so the terminal can repaint, then
      // start streaming live output.
      send("init", {
        info: session.info,
        scrollback: session.scrollback(),
      });

      session.attachListener();
      session.on("data", onData);
      session.on("exit", onExit);
      abortSignal.addEventListener("abort", onAbort);

      // If the session already exited before we attached, surface it
      // immediately and close.
      if (session.info.exited) {
        send("exit", {
          code: session.info.exitCode ?? 0,
          signal: session.info.exitSignal ?? null,
        });
        close();
      }
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
