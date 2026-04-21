import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getStore } from "@/lib/runtime";
import { buildWebhookPayload, dispatchWebhook } from "@/lib/runtime/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/runtime/webhook/test — fire a synthetic `task.updated`
 * payload to the configured webhook so operators can verify wiring
 * without dragging cards on the Kanban board. Returns the dispatch
 * outcome so the UI can show success / failure inline.
 *
 * Unlike the production fire path this *is* awaited by the request so
 * the operator gets immediate feedback. Still bounded by the 5s
 * per-attempt timeout in `dispatchWebhook`.
 */
export async function POST(): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const snap = await getStore().snapshot();
  const cfg = snap.harness.webhook;
  if (!cfg || !cfg.enabled || !cfg.url) {
    return NextResponse.json({ error: "webhook_disabled" }, { status: 400 });
  }
  const payload = buildWebhookPayload(
    "task.updated",
    {
      id: "T-test",
      title: "claude-codex test event",
      column: "backlog",
      createdAt: Date.now(),
    },
    {
      id: "T-test",
      title: "claude-codex test event",
      column: "active",
      createdAt: Date.now(),
    },
  );
  const result = await dispatchWebhook(cfg, payload);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
