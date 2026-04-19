import { NextResponse } from "next/server";

import { clearSessionCookie } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout
 *
 * Clears the dashboard session cookie. The on-disk OpenAI token is
 * intentionally left in place so the CLI gateway keeps working — to
 * fully sign out, delete `~/.codex-gateway/token.json`.
 */
export async function POST(): Promise<NextResponse> {
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
