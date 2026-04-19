import { isSessionAuthenticated } from "@/lib/auth/session";
import { getStore } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/runtime/state
 *
 * Server-Sent Events stream of the entire runtime snapshot. Sends an
 * initial snapshot on connect, then a fresh snapshot whenever the
 * store fires `change`. Includes a 25s heartbeat so reverse proxies
 * don't time the connection out.
 */
export async function GET(req: Request): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const store = getStore();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          /* ignore */
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        store.off("change", onChange);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      const onChange = (snap: unknown) => send("state", snap);
      store.on("change", onChange);
      const heartbeat = setInterval(() => send("ping", { t: Date.now() }), 25_000);

      req.signal.addEventListener("abort", close);

      send("state", await store.snapshot());
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
