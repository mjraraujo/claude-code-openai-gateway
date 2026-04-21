import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getStore, normalizeWebhook, type WebhookConfig } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchBody {
  webhook?: unknown;
}

/** GET /api/runtime/webhook — returns the current config (secret redacted). */
export async function GET(): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const snap = await getStore().snapshot();
  return NextResponse.json({ webhook: redactWebhook(snap.harness.webhook) });
}

/**
 * PATCH /api/runtime/webhook  body: { webhook: WebhookConfig | null }
 *
 * `null` (or `false`) clears the configuration entirely. An object is
 * normalized through {@link normalizeWebhook}; if the URL is invalid
 * the request is rejected so the UI can surface the error rather than
 * silently dropping the value.
 *
 * If the client omits `secret`, the existing secret (if any) is
 * preserved — this avoids the password-input round-trip leaking the
 * secret and lets users edit the URL without retyping it.
 */
export async function PATCH(req: Request): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Disable / clear path.
  if (body.webhook === null || body.webhook === false) {
    const next = await getStore().update((draft) => {
      draft.harness.webhook = null;
    });
    return NextResponse.json({ webhook: redactWebhook(next.harness.webhook) });
  }

  if (!body.webhook || typeof body.webhook !== "object") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const incoming = body.webhook as Record<string, unknown>;
  const snap = await getStore().snapshot();
  const existing = snap.harness.webhook;

  // Carry the existing secret forward when the client omits it so the
  // UI can patch the URL / enabled flag without round-tripping the
  // secret (which it never receives back from GET).
  const merged: Record<string, unknown> = {
    url: incoming.url,
    enabled: incoming.enabled,
    secret:
      typeof incoming.secret === "string"
        ? incoming.secret
        : existing?.secret,
  };

  const normalized = normalizeWebhook(merged);
  if (!normalized) {
    return NextResponse.json({ error: "invalid_webhook" }, { status: 400 });
  }

  const next = await getStore().update((draft) => {
    draft.harness.webhook = normalized;
  });
  return NextResponse.json({ webhook: redactWebhook(next.harness.webhook) });
}

/**
 * Strip the secret from outbound responses. The presence of a secret
 * is still surfaced via `hasSecret` so the UI can show "configured".
 */
function redactWebhook(
  cfg: WebhookConfig | null,
): (Omit<WebhookConfig, "secret"> & { hasSecret: boolean }) | null {
  if (!cfg) return null;
  return { url: cfg.url, enabled: cfg.enabled, hasSecret: !!cfg.secret };
}
