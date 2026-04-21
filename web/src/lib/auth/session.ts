/**
 * Cookie-based session for the Claude Codex dashboard.
 *
 * The session value is the dummy `sk-ant-…` API key generated and
 * cached by `getOrCreateSessionApiKey()`. The browser presenting a
 * cookie that matches the on-disk key is considered authenticated for
 * the purposes of the dashboard. The same key is also what the local
 * proxy expects when forwarding Anthropic-style requests, so a single
 * value drives both the UI auth and the gateway's `Authorization`
 * header.
 */

import { cookies, headers } from "next/headers";

import { envFlag } from "@/lib/env";

import { SESSION_COOKIE_NAME } from "./constants";
import { getSessionApiKey } from "./storage";

export { SESSION_COOKIE_NAME };

const ONE_DAY_SECONDS = 60 * 60 * 24;

interface SetSessionOptions {
  apiKey: string;
  maxAgeSeconds?: number;
}

/**
 * Decide whether to mark the session cookie as `Secure`.
 *
 * Browsers refuse to store `Secure` cookies on plain-`http://` origins,
 * which silently breaks login on a freshly-provisioned VPS that hasn't
 * been put behind TLS yet. To make the dashboard "just work" everywhere
 * we auto-detect the request scheme:
 *
 *  - Direct HTTPS request (`x-forwarded-proto: https` from a reverse
 *    proxy, or a request URL starting with `https://`): cookie is
 *    `Secure`.
 *  - Plain HTTP (typical for `http://<vps-ip>:3000` before TLS is set
 *    up, or local `http://localhost:3000`): cookie is **not** `Secure`,
 *    so the browser actually stores it.
 *
 * Two explicit overrides remain, for setups where the auto-detection
 * is wrong:
 *
 *  - `CLAUDE_CODEX_FORCE_SECURE_COOKIES=1` (alias `MISSION_CONTROL_FORCE_SECURE_COOKIES=1`) → always `Secure`.
 *  - `CLAUDE_CODEX_INSECURE_COOKIES=1` (alias `MISSION_CONTROL_INSECURE_COOKIES=1`) → never `Secure`.
 *
 * Exported for testing.
 */
export function shouldUseSecureCookie(requestProto?: string): boolean {
  if (envFlag("CLAUDE_CODEX_FORCE_SECURE_COOKIES", "MISSION_CONTROL_FORCE_SECURE_COOKIES")) return true;
  if (envFlag("CLAUDE_CODEX_INSECURE_COOKIES", "MISSION_CONTROL_INSECURE_COOKIES")) return false;
  if (requestProto) {
    return requestProto.toLowerCase() === "https";
  }
  // Conservative fallback when we have no request context at all
  // (e.g. unit tests): keep the legacy behaviour so we don't accidentally
  // serve a non-Secure cookie in production.
  return process.env.NODE_ENV === "production";
}

/**
 * Resolve the effective request scheme from Next.js request headers.
 * Honours `x-forwarded-proto` (set by Caddy/Nginx) before falling back
 * to whatever Next put in `host`. Returns `undefined` when called
 * outside a request scope.
 */
async function detectRequestProto(): Promise<string | undefined> {
  try {
    const h = await headers();
    const fwd = h.get("x-forwarded-proto");
    if (fwd) {
      // Some proxies send a comma-separated list — take the first hop.
      const first = fwd.split(",")[0]?.trim().toLowerCase();
      if (first === "http" || first === "https") return first;
    }
    // Next 16 exposes the original URL via `x-forwarded-proto` from its
    // own server too; if it's missing we have no reliable signal, so
    // return undefined and let the env-var fallback decide.
    return undefined;
  } catch {
    return undefined;
  }
}

export async function setSessionCookie({
  apiKey,
  maxAgeSeconds = ONE_DAY_SECONDS,
}: SetSessionOptions): Promise<void> {
  const proto = await detectRequestProto();
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE_NAME,
    value: apiKey,
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(proto),
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const proto = await detectRequestProto();
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(proto),
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
