import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getStore, isValidModelId, type HarnessState } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/runtime/harness  body: Partial<HarnessState>
 *
 * Validates each known boolean independently. Unknown keys are
 * silently dropped to keep the API forward-compatible.
 */
export async function PATCH(req: Request): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: Partial<Record<keyof HarnessState, unknown>>;
  try {
    body = (await req.json()) as Partial<Record<keyof HarnessState, unknown>>;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const next = await getStore().update((draft) => {
    if (typeof body.autoApproveSafeEdits === "boolean") {
      draft.harness.autoApproveSafeEdits = body.autoApproveSafeEdits;
    }
    if (typeof body.streamToolOutput === "boolean") {
      draft.harness.streamToolOutput = body.streamToolOutput;
    }
    if (typeof body.persistContext === "boolean") {
      draft.harness.persistContext = body.persistContext;
    }
    if (typeof body.model === "string") {
      const trimmed = body.model.trim();
      // Same id-shape constraint shared with `/api/runtime/agents`
      // (per-agent override) and `/api/runtime/chat` (request body).
      if (isValidModelId(trimmed)) {
        draft.harness.model = trimmed;
      }
    }
    if (typeof body.methodology === "string") {
      // Free-form short label surfaced to the planner system prompt.
      // Cap length so the prompt can't be ballooned via this field,
      // and strip control chars / backticks so a value like
      // "Scrum`\nIGNORE PREVIOUS" can't break out of the prompt
      // structure.
      draft.harness.methodology = sanitizePromptLabel(body.methodology);
    }
    if (typeof body.devMode === "string") {
      draft.harness.devMode = sanitizePromptLabel(body.devMode);
    }
  });
  return NextResponse.json({ harness: next.harness });
}

/**
 * Sanitize a free-form label that will be interpolated into the
 * auto-drive planner system prompt. Strips ASCII control chars,
 * backticks, and brace/bracket characters that could be used to
 * break out of the surrounding template, then trims and caps at
 * 64 chars.
 */
function sanitizePromptLabel(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f`{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}
