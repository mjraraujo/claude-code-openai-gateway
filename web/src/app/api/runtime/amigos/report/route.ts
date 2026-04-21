/**
 * GET /api/runtime/amigos/report
 *
 * Returns the last persisted Three Amigos report (or `{ report: null }`
 * if none exists). The dashboard reads this on mount so a refresh
 * doesn't lose findings between SSE-driven runs.
 */

import { NextResponse } from "next/server";

import { isSessionAuthenticated } from "@/lib/auth/session";
import { getStore } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!(await isSessionAuthenticated())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const snap = await getStore().snapshot();
  return NextResponse.json({ report: snap.amigosReport ?? null });
}
