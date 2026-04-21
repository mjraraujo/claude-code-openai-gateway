/**
 * POST /api/runtime/chat/agent
 *
 * Streaming endpoint that runs the chat-agent tool-calling loop
 * (see `@/lib/runtime/chatAgent`) and forwards each generator event
 * to the browser as a Server-Sent Event. This is the surface that
 * unblocks the bug from the problem statement: the chat dock can
 * now create files, exec commands, and inspect the workspace
 * because it goes through the same tool harness as auto-drive.
 *
 * Request body:
 *   {
 *     goal: string,           // the user's most recent request
 *     model?: string,         // overrides HarnessState.model
 *     maxSteps?: number,      // optional, capped at 12
 *   }
 *
 * Response: text/event-stream of frames shaped like
 *   event: <type>
 *   data: <json>
 *
 * Where <type> is one of `thought | tool_call | tool_result |
 * message | done | error` (see `ChatAgentEvent`).
 *
 * Auth: same session cookie as every other /api/runtime/* route.
 */

import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import {
  getStore,
  isValidModelId,
  isValidPersona,
  type RufloPersona,
} from "@/lib/runtime";
import { CHAT_AGENT_MAX_STEPS, runChatAgent, type ChatAgentEvent } from "@/lib/runtime/chatAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_GOAL_CHARS = 8_000;

interface Body {
  goal?: unknown;
  model?: unknown;
  maxSteps?: unknown;
  methodology?: unknown;
  devMode?: unknown;
  persona?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const goal =
    typeof body.goal === "string" ? body.goal.slice(0, MAX_GOAL_CHARS).trim() : "";
  if (!goal) {
    return NextResponse.json({ error: "missing_goal" }, { status: 400 });
  }

  // Resolve model: explicit override → persisted harness default.
  // The model is also revalidated by the planner when it fans out to
  // the gateway.
  const snap = await getStore().snapshot();
  let model = snap.harness.model;
  if (typeof body.model === "string" && body.model.trim()) {
    if (!isValidModelId(body.model.trim())) {
      return NextResponse.json({ error: "invalid_model" }, { status: 400 });
    }
    model = body.model.trim();
  }
  // Methodology / devMode / persona: caller can override per-turn,
  // otherwise inherit from the persisted harness so the chat surface
  // respects whatever the operator picked in the Kanban panel.
  const methodology =
    typeof body.methodology === "string"
      ? body.methodology.slice(0, 64)
      : snap.harness.methodology;
  const devMode =
    typeof body.devMode === "string"
      ? body.devMode.slice(0, 64)
      : snap.harness.devMode;
  let persona: RufloPersona | undefined = snap.harness.persona ?? undefined;
  if (body.persona !== undefined) {
    if (isValidPersona(body.persona)) persona = body.persona;
  }

  const maxSteps =
    typeof body.maxSteps === "number" && Number.isFinite(body.maxSteps)
      ? Math.max(1, Math.min(CHAT_AGENT_MAX_STEPS, Math.floor(body.maxSteps)))
      : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatAgentEvent) => {
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
        } catch {
          /* controller closed */
        }
      };

      try {
        for await (const ev of runChatAgent({
          goal,
          model,
          maxSteps,
          methodology,
          devMode,
          persona,
          signal: req.signal,
        })) {
          send(ev);
          if (ev.type === "done" || ev.type === "error") break;
        }
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
