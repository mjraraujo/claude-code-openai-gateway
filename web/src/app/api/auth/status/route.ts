import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getValidToken } from "@/lib/auth/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/status
 *
 * Reports whether the browser cookie is valid and whether the on-disk
 * Codex token is currently usable. The dashboard polls this on load to
 * decide whether to render Mission Control or redirect to `/login`.
 */
export async function GET(): Promise<NextResponse> {
  const [authenticated, token] = await Promise.all([
    isSessionAuthenticated(),
    getValidToken(),
  ]);
  return NextResponse.json({
    authenticated,
    token_valid: token !== null,
    token_expires_at: token?.expires_at ?? null,
  });
}
