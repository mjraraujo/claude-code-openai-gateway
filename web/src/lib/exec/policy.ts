/**
 * Exec policy: allow / deny rules + timeout for `/api/exec`.
 *
 * The Mission Control terminal already runs arbitrary `bash -lc`
 * inside the gateway repo; the only access control is the session
 * cookie. As we hand the same exec route to chat-driven tool calls
 * (Phase 2 follow-up), we want a configurable safety rail beyond
 * the existing fat-finger blocklist:
 *
 *   - **Deny** patterns block a command outright (returns
 *     `command_blocked` with the matching pattern). Defaults catch
 *     the most catastrophic shell footguns and run on top of the
 *     existing `BLOCKED_COMMAND_PATTERNS` so removing one doesn't
 *     accidentally weaken the route.
 *   - **Allow** patterns, when configured, *restrict* the route to
 *     commands that match at least one allow rule. This is the knob
 *     to use when an operator wants the terminal to only run a
 *     known whitelist (e.g. `git`, `npm`, `node`).
 *   - **Timeout** caps individual commands. Defaults to 5 minutes
 *     (matching the historical `MAX_DURATION_MS`).
 *
 * The module is *pure* (no I/O, no React) so it can be unit-tested
 * cheaply in vitest's node env. The exec route imports `evaluate()`
 * and applies the verdict before spawning a child process.
 *
 * Patterns: each pattern is a literal substring match against the
 * trimmed command. We deliberately avoid regex here — patterns come
 * from environment variables / settings UI and a malformed regex
 * would make the route fail closed in a confusing way. A literal
 * match is conservative and easy for an operator to reason about.
 */

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Hard floor / ceiling for the configurable timeout. The floor
 * stops "1ms timeout" footguns; the ceiling matches the SSE keep-
 * alive horizon — anything longer should be a background job, not
 * a chat-driven exec.
 */
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Defaults that catch the most obviously catastrophic shell foot-
 * guns. These were previously hard-coded in the exec route as
 * `BLOCKED_COMMAND_PATTERNS`; we centralise them here so the
 * settings UI can show them and so they can be unit-tested.
 */
export const DEFAULT_DENY_PATTERNS: readonly string[] = [
  "rm -rf /",
  "sudo ",
  // Fork bomb signature — the literal `:(){`.
  ":(){",
  "mkfs",
  "shutdown",
  "reboot",
  "dd if=",
];

export interface ExecPolicy {
  /**
   * Substrings that, if any are present in the command, cause it
   * to be rejected. Always includes `DEFAULT_DENY_PATTERNS`.
   */
  deny: readonly string[];
  /**
   * If non-empty, *only* commands matching at least one of these
   * substrings are allowed. Empty array (the default) means no
   * allow-list filtering — every non-denied command runs.
   */
  allow: readonly string[];
  /** Timeout in ms applied to each command. */
  timeoutMs: number;
}

export interface PolicyVerdict {
  allowed: boolean;
  /** Populated when `allowed` is false. */
  reason?: "deny_match" | "no_allow_match" | "empty_command";
  /** The matching deny/allow pattern when applicable. */
  matchedPattern?: string;
}

/**
 * Build a normalized `ExecPolicy` from optional partial input.
 *
 * - Unknown / non-string entries in `deny` / `allow` are dropped.
 * - Whitespace-only patterns are dropped.
 * - The default deny list is *always* merged in (the operator can
 *   add to it but cannot remove from it via this constructor).
 * - `timeoutMs` is clamped to `[MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]`
 *   and falls back to `DEFAULT_TIMEOUT_MS` for non-finite input.
 */
export function buildPolicy(input?: {
  deny?: readonly unknown[];
  allow?: readonly unknown[];
  timeoutMs?: unknown;
}): ExecPolicy {
  const userDeny = filterPatterns(input?.deny);
  const allow = filterPatterns(input?.allow);
  // De-duplicate the merged deny list while preserving order so the
  // default patterns appear first in the settings UI.
  const denyAll = Array.from(new Set([...DEFAULT_DENY_PATTERNS, ...userDeny]));
  const timeoutMs = clampTimeout(input?.timeoutMs);
  return { deny: denyAll, allow, timeoutMs };
}

/**
 * Decide whether `command` is allowed under `policy`. The command
 * is trimmed before matching so leading/trailing whitespace doesn't
 * cause false positives.
 *
 * Order of checks:
 *   1. Empty after trim → `empty_command`
 *   2. Any deny pattern matches → `deny_match`
 *   3. Allow list configured but no entry matches → `no_allow_match`
 *   4. Otherwise → allowed.
 */
export function evaluate(command: string, policy: ExecPolicy): PolicyVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: "empty_command" };
  for (const p of policy.deny) {
    if (trimmed.includes(p)) {
      return { allowed: false, reason: "deny_match", matchedPattern: p };
    }
  }
  if (policy.allow.length > 0) {
    let matched: string | undefined;
    for (const p of policy.allow) {
      if (trimmed.includes(p)) {
        matched = p;
        break;
      }
    }
    if (!matched) return { allowed: false, reason: "no_allow_match" };
    return { allowed: true, matchedPattern: matched };
  }
  return { allowed: true };
}

/**
 * Resolve the active policy from environment variables. This lets
 * operators tighten the route in production without redeploying
 * the UI:
 *
 *   - `CLAUDE_CODEX_EXEC_DENY` (alias `MISSION_CONTROL_EXEC_DENY`)   — comma-separated extra deny patterns
 *   - `CLAUDE_CODEX_EXEC_ALLOW` (alias `MISSION_CONTROL_EXEC_ALLOW`)  — comma-separated allow patterns
 *   - `CLAUDE_CODEX_EXEC_TIMEOUT_MS` (alias `MISSION_CONTROL_EXEC_TIMEOUT_MS`) — numeric override
 *
 * Returns the same `ExecPolicy` shape the route uses internally,
 * with the defaults applied.
 */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): ExecPolicy {
  const denyRaw = env.CLAUDE_CODEX_EXEC_DENY ?? env.MISSION_CONTROL_EXEC_DENY;
  const allowRaw = env.CLAUDE_CODEX_EXEC_ALLOW ?? env.MISSION_CONTROL_EXEC_ALLOW;
  const timeoutRaw =
    env.CLAUDE_CODEX_EXEC_TIMEOUT_MS ?? env.MISSION_CONTROL_EXEC_TIMEOUT_MS;
  return buildPolicy({
    deny: splitCsv(denyRaw),
    allow: splitCsv(allowRaw),
    timeoutMs: timeoutRaw ? Number(timeoutRaw) : undefined,
  });
}

function filterPatterns(input: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    out.push(trimmed);
  }
  return out;
}

function splitCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function clampTimeout(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(raw)));
}
