/**
 * OAuth device-code flow against auth.openai.com — mirrors the
 * implementation in `bin/gateway.js` so both the CLI gateway and the
 * web app share identical behavior and storage.
 *
 * These constants are intentionally identical to the codex-rs values
 * referenced from `bin/gateway.js:28-35`.
 */

export const AUTH_ISSUER = "https://auth.openai.com";
export const DEVICE_USERCODE_URL = `${AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
export const DEVICE_TOKEN_URL = `${AUTH_ISSUER}/api/accounts/deviceauth/token`;
export const DEVICE_VERIFY_URL = `${AUTH_ISSUER}/codex/device`;
export const OAUTH_TOKEN_URL = `${AUTH_ISSUER}/oauth/token`;
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export interface DeviceCodeResponse {
  device_auth_id: string;
  user_code: string;
  interval?: string | number;
  expires_at?: string;
}

export interface PollPendingResponse {
  status: "pending";
}

export interface PollSuccessResponse {
  status: "complete";
  authorization_code: string;
  code_verifier: string;
}

export type PollResponse = PollPendingResponse | PollSuccessResponse;

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at: number;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Request to ${url} failed with ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response from ${url}`);
  }
}

async function postForm<T>(url: string, body: Record<string, string>): Promise<T> {
  const params = new URLSearchParams(body);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Request to ${url} failed with ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response from ${url}`);
  }
}

/** Step 1: request a device code from auth.openai.com. */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const resp = await postJson<DeviceCodeResponse>(DEVICE_USERCODE_URL, {
    client_id: CLIENT_ID,
  });
  if (!resp.device_auth_id || !resp.user_code) {
    throw new Error("Device code request returned an unexpected payload");
  }
  return resp;
}

/**
 * Step 2: poll auth.openai.com to see whether the user completed the
 * browser sign-in. Returns `{ status: "pending" }` until the
 * `authorization_code` is available.
 */
export async function pollDeviceCode(
  device_auth_id: string,
  user_code: string,
): Promise<PollResponse> {
  let resp: {
    authorization_code?: string;
    code_verifier?: string;
  };
  try {
    resp = await postJson(DEVICE_TOKEN_URL, { device_auth_id, user_code });
  } catch {
    // Pending polls return non-2xx / non-JSON. Treat as pending.
    return { status: "pending" };
  }

  if (!resp.authorization_code || !resp.code_verifier) {
    return { status: "pending" };
  }
  return {
    status: "complete",
    authorization_code: resp.authorization_code,
    code_verifier: resp.code_verifier,
  };
}

/** Step 3: exchange the authorization code for a real access token. */
export async function exchangeAuthorizationCode(
  authorization_code: string,
  code_verifier: string,
): Promise<TokenData> {
  const redirectUri = `${AUTH_ISSUER}/deviceauth/callback`;
  const resp = await postForm<{
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  }>(OAUTH_TOKEN_URL, {
    grant_type: "authorization_code",
    code: authorization_code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: code_verifier,
  });

  if (!resp.access_token) {
    throw new Error("Token exchange did not return an access_token");
  }

  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    id_token: resp.id_token,
    expires_at: Date.now() + (resp.expires_in ?? 86400) * 1000,
  };
}

/** Refresh an access token using a refresh token. Returns null on failure. */
export async function refreshAccessToken(
  refresh_token: string,
): Promise<TokenData | null> {
  try {
    const resp = await postForm<{
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    }>(OAUTH_TOKEN_URL, {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token,
    });
    if (!resp.access_token) return null;
    return {
      access_token: resp.access_token,
      refresh_token: resp.refresh_token ?? refresh_token,
      id_token: resp.id_token,
      expires_at: Date.now() + (resp.expires_in ?? 86400) * 1000,
    };
  } catch {
    return null;
  }
}
