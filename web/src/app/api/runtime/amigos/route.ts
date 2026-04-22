/**
 * POST   /api/runtime/amigos       — start a Three Amigos run (SSE)
 * DELETE /api/runtime/amigos       — abort the in-flight run
 *
 * SSE event types: `discovered` · `scenario_started` · `amigo_done` ·
 * `scenario_done` · `summary` · `error` · `ping` (heartbeat).
 *
 * The route owns one singleton run at a time — a second POST while a
 * run is in flight returns 409. The pure orchestration lives in
 * `runAmigos()` (see `web/src/lib/runtime/amigos.ts`); this file only
 * deals with the HTTP / SSE shape and persistence.
 */

import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import {
  type AmigosEvent,
  type AmigosScope,
  runAmigos,
} from "@/lib/runtime/amigos";
import { getStore } from "@/lib/runtime";
import { normalizeAmigosReport } from "@/lib/runtime/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ActiveRun {
  abort: AbortController;
  startedAt: number;
}
let active: ActiveRun | null = null;

interface PostBody {
  /** Scope discriminator. Accepts the canonical `type` field (matching
   * the {@link AmigosScope} shape the dashboard sends) and the legacy
   * `scope` field. */
  type?: unknown;
  scope?: unknown;
  path?: unknown;
  scenarioId?: unknown;
  concurrency?: unknown;
  model?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (active) {
    return NextResponse.json(
      { error: "amigos_already_running" },
      { status: 409 },
    );
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const scope = parseScope(body);
  if (!scope) {
    return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  }

  const snap = await getStore().snapshot();
  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : snap.harness.model;
  const concurrency =
    typeof body.concurrency === "number" && Number.isFinite(body.concurrency)
      ? Math.max(1, Math.min(8, Math.floor(body.concurrency)))
      : undefined;

  const ctrl = new AbortController();
  active = { abort: ctrl, startedAt: Date.now() };
  const cleanup = () => {
    if (active?.abort === ctrl) active = null;
  };
  if (req.signal) {
    if (req.signal.aborted) ctrl.abort();
    else req.signal.addEventListener("abort", () => ctrl.abort());
  }

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
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };
      const heartbeat = setInterval(
        () => send("ping", { t: Date.now() }),
        25_000,
      );

      const onEvent = (evt: AmigosEvent) => send(evt.type, evt);

      try {
        const report = await runAmigos({
          scope,
          model,
          signal: ctrl.signal,
          concurrency,
          onEvent,
        });

        // Persist the report (bounded shape). Best-effort; never
        // block the response on persistence.
        const normalised = normalizeAmigosReport(report);
        if (normalised) {
          await getStore()
            .update((draft) => {
              draft.amigosReport = normalised;
            })
            .catch(() => undefined);
        }
      } catch (err) {
        send("error", { message: (err as Error).message });
      } finally {
        cleanup();
        close();
      }
    },
    cancel() {
      ctrl.abort();
      cleanup();
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

export async function DELETE(): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!active) return NextResponse.json({ ok: true, idle: true });
  active.abort.abort();
  active = null;
  return NextResponse.json({ ok: true });
}

function parseScope(body: PostBody): AmigosScope | null {
  // Accept both the canonical `type` discriminator (what the dashboard
  // sends — it stringifies an AmigosScope directly) and the legacy
  // `scope` field that earlier callers used.
  const t = typeof body.type === "string" ? body.type : body.scope;
  if (t === "all") return { type: "all" };
  if (t === "feature" && typeof body.path === "string" && body.path.trim()) {
    return { type: "feature", path: body.path };
  }
  if (
    t === "scenario" &&
    typeof body.path === "string" &&
    body.path.trim() &&
    typeof body.scenarioId === "string" &&
    body.scenarioId.trim()
  ) {
    return {
      type: "scenario",
      path: body.path,
      scenarioId: body.scenarioId,
    };
  }
  return null;
}
