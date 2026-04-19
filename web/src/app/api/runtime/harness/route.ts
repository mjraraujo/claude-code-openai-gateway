import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getStore, type HarnessState } from "@/lib/runtime";

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
      // Keep the value pragmatic: short, single-line, no surprises.
      if (trimmed && trimmed.length <= 64 && /^[\w.\-:/]+$/.test(trimmed)) {
        draft.harness.model = trimmed;
      }
    }
  });
  return NextResponse.json({ harness: next.harness });
}
