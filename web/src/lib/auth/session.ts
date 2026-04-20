/**
 * Cookie-based session for the Mission Control dashboard.
 *
 * The session value is the dummy `sk-ant-…` API key generated and
 * cached by `getOrCreateSessionApiKey()`. The browser presenting a
 * cookie that matches the on-disk key is considered authenticated for
 * the purposes of the dashboard. The same key is also what the local
 * proxy expects when forwarding Anthropic-style requests, so a single
 * value drives both the UI auth and the gateway's `Authorization`
 * header.
 */

import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME } from "./constants";
import { getSessionApiKey } from "./storage";

export { SESSION_COOKIE_NAME };

const ONE_DAY_SECONDS = 60 * 60 * 24;

interface SetSessionOptions {
  apiKey: string;
  maxAgeSeconds?: number;
}

/**
 * Whether to mark the session cookie as `Secure`. We default to `true`
 * in production so the cookie is never sent over plain HTTP, but allow
 * an explicit opt-out via `MISSION_CONTROL_INSECURE_COOKIES=1` for
 * setups that haven't configured TLS yet (e.g. a freshly-provisioned
 * VPS where the user wants to load the dashboard at
 * `http://<vps-ip>:3000` before wiring up Caddy + a domain).
 *
 * Exported for testing.
 */
export function shouldUseSecureCookie(): boolean {
  if (process.env.MISSION_CONTROL_INSECURE_COOKIES === "1") return false;
  return process.env.NODE_ENV === "production";
}

export async function setSessionCookie({
  apiKey,
  maxAgeSeconds = ONE_DAY_SECONDS,
}: SetSessionOptions): Promise<void> {
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE_NAME,
    value: apiKey,
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: 0,
  });
}

/**
 * Returns true when the request carries a valid session cookie that
 * matches the persisted dummy session key. Used by API routes; route
 * handlers in the App Router run on the server.
 */
export async function isSessionAuthenticated(): Promise<boolean> {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) return false;
  const persisted = await getSessionApiKey();
  if (!persisted) return false;
  return constantTimeEquals(cookie, persisted);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
