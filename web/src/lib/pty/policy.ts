/**
 * Pure helpers that turn the operator's choice ("claude" tab or
 * "shell" tab) into a concrete `SpawnOptions` for the PTY session
 * manager. Kept separate from `sessionManager` so the policy
 * (env vars, paths, fallback shell) can be unit-tested without
 * touching `node-pty`.
 */

import path from "node:path";
import { existsSync } from "node:fs";

import { WORKSPACE_ROOT } from "@/lib/fs/workspace";
import { getGatewayUrl } from "@/lib/runtime/gateway";

import type { SpawnOptions } from "./sessionManager";

/** Tab kind selected from the dashboard. */
export type PtyKind = "claude" | "shell";

/**
 * Resolve the binary to spawn for a Claude PTY tab. Pure helper
 * (takes lookup callbacks + an optional override) so it can be
 * unit-tested without touching the real filesystem.
 *
 * Resolution order:
 *   1. `CLAUDE_CODEX_PTY_BIN` env var (escape hatch for operators).
 *   2. The `claude-codex` wrapper symlinked into the runtime image
 *      by the Dockerfile (`/usr/local/bin/claude-codex`).
 *   3. The official Anthropic CLI (`claude`) on `$PATH`.
 *   4. `bash -l` as a last resort so the PTY at least opens with a
 *      friendly message instead of failing to spawn outright.
 */
export interface ResolveDeps {
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
}

export function resolveClaudeBinary(deps: ResolveDeps): {
  shell: string;
  args: readonly string[];
  fellBack: boolean;
} {
  const override = deps.env.CLAUDE_CODEX_PTY_BIN;
  if (override && override.trim()) {
    return { shell: override.trim(), args: [], fellBack: false };
  }
  for (const candidate of ["/usr/local/bin/claude-codex", "/usr/bin/claude-codex"]) {
    if (deps.exists(candidate)) {
      return { shell: candidate, args: [], fellBack: false };
    }
  }
  for (const candidate of ["/usr/local/bin/claude", "/usr/bin/claude"]) {
    if (deps.exists(candidate)) {
      return {
        shell: candidate,
        args: ["--dangerously-skip-permissions"],
        fellBack: false,
      };
    }
  }
  // Fallback so the tab still opens — the UI surfaces the warning.
  return { shell: "/bin/bash", args: ["-l"], fellBack: true };
}

/** Resolve the shell binary for a generic shell tab. Same shape as
 * `resolveClaudeBinary` so it's testable. */
export function resolveShellBinary(deps: ResolveDeps): {
  shell: string;
  args: readonly string[];
} {
  const fromEnv = deps.env.SHELL;
  if (fromEnv && fromEnv.trim() && deps.exists(fromEnv.trim())) {
    return { shell: fromEnv.trim(), args: ["-l"] };
  }
  for (const c of ["/bin/bash", "/usr/bin/bash"]) {
    if (deps.exists(c)) return { shell: c, args: ["-l"] };
  }
  return { shell: "/bin/sh", args: [] };
}

/**
 * Build the env block fed to a Claude PTY session. The local
 * gateway (bin/gateway.js) is Anthropic-Messages-shaped and runs on
 * 127.0.0.1, so we point the CLI at it and inject a dummy API key
 * so the Anthropic SDK doesn't refuse to start.
 *
 * Pure helper — takes the gateway URL as an argument so tests don't
 * have to mock the whole runtime/store module graph.
 */
export function buildClaudeEnv(
  base: Record<string, string | undefined>,
  gatewayUrl: string,
): Record<string, string | undefined> {
  // The local gateway always exposes the Anthropic Messages endpoint
  // at `/v1/messages` (see `bin/gateway.js`), but the Anthropic SDK's
  // `ANTHROPIC_BASE_URL` expects the *origin* (no path) and re-appends
  // `/v1/messages` itself. We therefore strip a trailing
  // `/v1/messages` (with optional slash) and leave any other URL
  // shape untouched. If the gateway path ever changes, this regex
  // and the gateway entrypoint must be updated together.
  const origin = gatewayUrl.replace(/\/v1\/messages\/?$/, "");
  return {
    ...base,
    ANTHROPIC_BASE_URL: origin,
    // The SDK refuses to start without one. The local gateway
    // ignores it and uses its own OAuth token.
    ANTHROPIC_API_KEY: base.ANTHROPIC_API_KEY ?? "claude-codex-dummy-key",
    TERM: "xterm-256color",
    FORCE_COLOR: "1",
  };
}

/**
 * Build the full `SpawnOptions` for a new PTY session. Side-effecting
 * only because it consults `existsSync` and `getGatewayUrl()`; the
 * pure pieces above can be tested in isolation.
 */
export async function buildSpawnOptions(
  kind: PtyKind,
  cols: number | undefined,
  rows: number | undefined,
): Promise<SpawnOptions> {
  const deps: ResolveDeps = { env: process.env, exists: existsSync };
  if (kind === "claude") {
    const bin = resolveClaudeBinary(deps);
    const gatewayUrl = getGatewayUrl();
    const env = buildClaudeEnv(process.env, gatewayUrl);
    return {
      shell: bin.shell,
      args: bin.args,
      cwd: WORKSPACE_ROOT,
      env,
      cols,
      rows,
      label: bin.fellBack ? "claude (bash fallback)" : "claude",
    };
  }
  const sh = resolveShellBinary(deps);
  return {
    shell: sh.shell,
    args: sh.args,
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, TERM: "xterm-256color" },
    cols,
    rows,
    label: path.basename(sh.shell),
  };
}
