/**
 * On-disk persistence for OAuth tokens and the dummy session API key.
 *
 * Files live under `~/.codex-gateway/` so the web dashboard and the
 * existing `bin/gateway.js` CLI share state — logging in via the
 * dashboard authorises the CLI and vice-versa.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import type { TokenData } from "./codex";

const CONFIG_DIR = path.join(
  process.env.CODEX_GATEWAY_CONFIG_DIR || os.homedir() || ".",
  ".codex-gateway",
);
const TOKEN_FILE = path.join(CONFIG_DIR, "token.json");
const SESSION_KEY_FILE = path.join(CONFIG_DIR, "session-key.json");

async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

export async function loadToken(): Promise<TokenData | null> {
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
    const data = JSON.parse(raw) as TokenData;
    if (!data.access_token || typeof data.expires_at !== "number") {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function saveToken(data: TokenData): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(TOKEN_FILE, JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
}

export async function clearToken(): Promise<void> {
  try {
    await fs.unlink(TOKEN_FILE);
  } catch {
    /* ignore */
  }
}

/**
 * Returns the current valid (not within 60s of expiry) token, or null.
 */
export async function getValidToken(): Promise<TokenData | null> {
  const data = await loadToken();
  if (!data) return null;
  if (Date.now() >= data.expires_at - 60_000) return null;
  return data;
}

interface SessionKeyData {
  api_key: string;
  created_at: number;
}

/**
 * Get-or-create a deterministic-per-install dummy `sk-ant-…` API key.
 * This mirrors `bin/gateway.js` (line ~576) which generates the key on
 * each launch — we persist it so cookies stay valid across restarts.
 */
export async function getOrCreateSessionApiKey(): Promise<string> {
  try {
    const raw = await fs.readFile(SESSION_KEY_FILE, "utf8");
    const data = JSON.parse(raw) as SessionKeyData;
    if (typeof data.api_key === "string" && data.api_key.startsWith("sk-ant-")) {
      return data.api_key;
    }
  } catch {
    /* fallthrough to generate */
  }

  const apiKey = `sk-ant-api03-${crypto
    .randomBytes(36)
    .toString("base64url")}-${crypto.randomBytes(18).toString("base64url")}`;
  const data: SessionKeyData = { api_key: apiKey, created_at: Date.now() };
  await ensureConfigDir();
  await fs.writeFile(SESSION_KEY_FILE, JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
  return apiKey;
}

export async function getSessionApiKey(): Promise<string | null> {
  try {
    const raw = await fs.readFile(SESSION_KEY_FILE, "utf8");
    const data = JSON.parse(raw) as SessionKeyData;
    return data.api_key ?? null;
  } catch {
    return null;
  }
}
