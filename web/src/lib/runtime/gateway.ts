/**
 * Gateway URL discovery for the Next.js dashboard.
 *
 * `bin/gateway.js` prefers port 18923 but will fall back to another
 * value in the 18923–18933 range when the preferred port is occupied
 * by a non-gateway process. When that happens the gateway writes the
 * chosen port to `~/.codex-gateway/port` (`PORT_FILE`) so consumers
 * like this module can locate it.
 *
 * Resolution order, highest precedence first:
 *
 *   1. Explicit URL override via `CLAUDE_CODEX_GATEWAY_URL` (or the
 *      legacy `MISSION_CONTROL_GATEWAY_URL`). Operators set this
 *      when the gateway lives on a non-standard host.
 *   2. The port file written by `bin/gateway.js` at startup.
 *   3. Hard-coded default `http://127.0.0.1:18923/v1/messages`.
 *
 * The port file is read synchronously and cached for `CACHE_TTL_MS` so
 * we don't hit disk on every chat request. It's a tiny ASCII file (a
 * single integer + newline), so sync reads are cheap and let callers
 * stay non-async.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readEnv } from "@/lib/env";

const MIN_PORT = 1;
const MAX_PORT = 65535;
const CACHE_TTL_MS = 2_000;

export const DEFAULT_GATEWAY_PORT = 18923;

function portFilePath(): string {
  return path.join(
    process.env.CODEX_GATEWAY_CONFIG_DIR || os.homedir() || ".",
    ".codex-gateway",
    "port",
  );
}

let cachedPort: number | null = null;
let cachedAt = 0;

/**
 * Read the gateway port from `~/.codex-gateway/port`, falling back to
 * the default 18923 when the file is missing, unreadable, or contains
 * an invalid value. Result is cached for a couple of seconds so the
 * hot chat path doesn't stat the file on every request.
 *
 * Exported separately from `getGatewayUrl()` so the unit test can
 * exercise the parsing logic without constructing URLs.
 */
export function getGatewayPort(): number {
  const now = Date.now();
  if (cachedPort !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedPort;
  }
  let port = DEFAULT_GATEWAY_PORT;
  try {
    const raw = fs.readFileSync(portFilePath(), "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= MIN_PORT && parsed <= MAX_PORT) {
      port = parsed;
    }
  } catch {
    // ENOENT and friends — fall through to the default.
  }
  cachedPort = port;
  cachedAt = now;
  return port;
}

/**
 * Resolve the full gateway URL for the Anthropic Messages endpoint
 * (`/v1/messages`). Honours the `CLAUDE_CODEX_GATEWAY_URL` /
 * `MISSION_CONTROL_GATEWAY_URL` env override before consulting the
 * port file.
 */
export function getGatewayUrl(): string {
  const override = readEnv("CLAUDE_CODEX_GATEWAY_URL", "MISSION_CONTROL_GATEWAY_URL");
  if (override) return override;
  return `http://127.0.0.1:${getGatewayPort()}/v1/messages`;
}

/**
 * Test-only: drop the in-memory cache so a unit test can observe a
 * fresh read after rewriting the port file.
 */
export function _resetGatewayPortCacheForTests(): void {
  cachedPort = null;
  cachedAt = 0;
}

export const _PORT_FILE_FOR_TESTS = portFilePath;
