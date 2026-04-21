/**
 * Cross-name environment-variable resolver.
 *
 * The dashboard was originally branded "Mission Control", so its
 * configuration env vars were prefixed `MISSION_CONTROL_*`. As of the
 * "Claude Codex" rebrand they're available under `CLAUDE_CODEX_*`
 * too, with the new names taking precedence. The legacy names are
 * still honoured so existing deployments / docker-compose files keep
 * working without operator action.
 *
 * Use `readEnv("CLAUDE_CODEX_FOO", "MISSION_CONTROL_FOO")` everywhere
 * a process.env lookup would otherwise be hard-wired to one prefix.
 */

export function readEnv(
  ...names: readonly string[]
): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/** True iff any of the named env vars equals "1" (after coercion). */
export function envFlag(...names: readonly string[]): boolean {
  return readEnv(...names) === "1";
}
