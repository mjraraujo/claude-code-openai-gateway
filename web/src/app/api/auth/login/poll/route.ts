import { NextResponse } from "next/server";

import {
  exchangeAuthorizationCode,
  pollDeviceCode,
} from "@/lib/auth/codex";
import { setSessionCookie } from "@/lib/auth/session";
import { getOrCreateSessionApiKey, saveToken } from "@/lib/auth/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PollBody {
  device_auth_id?: unknown;
  user_code?: unknown;
}

/**
 * POST /api/auth/login/poll
 *
 * Body: `{ device_auth_id, user_code }` from `/login/start`.
 *
 * Polls auth.openai.com once. Returns:
 *   - `{ status: "pending" }` while the user has not approved yet,
 *   - `{ status: "complete" }` once tokens are persisted and the
 *     session cookie has been set.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: PollBody;
  try {
    body = (await req.json()) as PollBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_request", message: "Body must be JSON" },
      { status: 400 },
    );
  }

  const deviceAuthId =
    typeof body.device_auth_id === "string" ? body.device_auth_id : null;
  const userCode = typeof body.user_code === "string" ? body.user_code : null;
  if (!deviceAuthId || !userCode) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: "device_auth_id and user_code are required",
      },
      { status: 400 },
    );
  }

  try {
    const poll = await pollDeviceCode(deviceAuthId, userCode);
    if (poll.status === "pending") {
      return NextResponse.json({ status: "pending" });
    }

    const token = await exchangeAuthorizationCode(
      poll.authorization_code,
      poll.code_verifier,
    );
    await saveToken(token);
    const apiKey = await getOrCreateSessionApiKey();
    await setSessionCookie({ apiKey });

    return NextResponse.json({
      status: "complete",
      expires_at: token.expires_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json(
      { error: "poll_failed", message },
      { status: 502 },
    );
  }
}
