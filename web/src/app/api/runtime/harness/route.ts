import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import {
  getStore,
  isValidDriveMode,
  isValidModelId,
  isValidPersona,
  type HarnessState,
} from "@/lib/runtime";
import {
  findDevMode,
  findMethodology,
  scaffoldMethodology,
  type ScaffoldResult,
} from "@/lib/runtime/methodology";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/runtime/harness  body: Partial<HarnessState>
 *
 * Validates each known boolean independently. Unknown keys are
 * silently dropped to keep the API forward-compatible.
 *
 * Side-effect: when `methodology` or `devMode` changes, the matching
 * registry entry's templates are scaffolded into the active
 * workspace (idempotent — existing files are never overwritten).
 * The set of files seeded is returned in the response so the UI
 * can surface a "Seeded N files in workspace … for <methodology>"
 * toast.
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
  // Capture the prior values so we only fire scaffolding when the
  // value actually changed (PATCH may carry the same values from
  // the UI on every save).
  const before = (await getStore().snapshot()).harness;
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
      if (isValidModelId(trimmed)) {
        draft.harness.model = trimmed;
      }
    }
    if (typeof body.methodology === "string") {
      draft.harness.methodology = sanitizePromptLabel(body.methodology);
    }
    if (typeof body.devMode === "string") {
      draft.harness.devMode = sanitizePromptLabel(body.devMode);
    }
    if (body.persona !== undefined) {
      if (isValidPersona(body.persona)) {
        draft.harness.persona = body.persona;
      }
    }
    if (body.driveMode !== undefined) {
      if (isValidDriveMode(body.driveMode)) {
        draft.harness.driveMode = body.driveMode;
      }
    }
  });

  // Fire scaffolding side-effects after the store has settled so
  // `scaffoldMethodology()` sees the new active workspace + harness
  // state. Errors here are non-fatal — the harness change has
  // already been persisted.
  const seeded: ScaffoldResult[] = [];
  if (next.harness.methodology !== before.methodology) {
    const entry = findMethodology(next.harness.methodology);
    if (entry) {
      try {
        seeded.push(await scaffoldMethodology(next, entry, "methodology"));
      } catch {
        /* non-fatal */
      }
    }
  }
  if (next.harness.devMode !== before.devMode) {
    const entry = findDevMode(next.harness.devMode);
    if (entry) {
      try {
        seeded.push(await scaffoldMethodology(next, entry, "devMode"));
      } catch {
        /* non-fatal */
      }
    }
  }

  return NextResponse.json({ harness: next.harness, scaffolded: seeded });
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
