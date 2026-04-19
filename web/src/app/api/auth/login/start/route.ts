import { NextResponse } from "next/server";

import {
  DEVICE_VERIFY_URL,
  requestDeviceCode,
} from "@/lib/auth/codex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login/start
 *
 * Initiates the OpenAI device-code flow. The browser shows the returned
 * `user_code` and prompts the user to open `verification_uri`.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const device = await requestDeviceCode();
    const intervalSeconds =
      typeof device.interval === "string"
        ? parseInt(device.interval, 10) || 5
        : (device.interval ?? 5);
    return NextResponse.json({
      device_auth_id: device.device_auth_id,
      user_code: device.user_code,
      verification_uri: DEVICE_VERIFY_URL,
      interval_seconds: intervalSeconds,
      expires_at: device.expires_at ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json(
      { error: "device_code_failed", message },
      { status: 502 },
    );
  }
}
