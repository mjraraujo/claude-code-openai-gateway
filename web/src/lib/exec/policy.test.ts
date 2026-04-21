import { describe, expect, it } from "vitest";

import {
  DEFAULT_DENY_PATTERNS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  buildPolicy,
  evaluate,
  policyFromEnv,
} from "./policy";

describe("buildPolicy", () => {
  it("applies the default deny list when no input is given", () => {
    const p = buildPolicy();
    expect(p.deny).toEqual(DEFAULT_DENY_PATTERNS);
    expect(p.allow).toEqual([]);
    expect(p.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("merges user deny patterns on top of the defaults, dedup'd", () => {
    const p = buildPolicy({
      deny: ["foo", "rm -rf /", "  bar  "], // duplicate + whitespace
    });
    // defaults preserved, custom appended, no dupes, trimmed
    for (const def of DEFAULT_DENY_PATTERNS) {
      expect(p.deny).toContain(def);
    }
    expect(p.deny).toContain("foo");
    expect(p.deny).toContain("bar");
    expect(p.deny.filter((d) => d === "rm -rf /").length).toBe(1);
    expect(p.deny).not.toContain("");
  });

  it("drops non-string and empty entries from allow / deny", () => {
    // Cast through unknown[] because the helper accepts `readonly unknown[]`.
    const p = buildPolicy({
      deny: [1, null, "valid", "  ", true] as unknown[],
      allow: ["", "git", undefined, "npm "] as unknown[],
    });
    expect(p.deny).toContain("valid");
    expect(p.allow).toEqual(["git", "npm"]);
  });

  it("clamps and floors the timeout", () => {
    expect(buildPolicy({ timeoutMs: 1 }).timeoutMs).toBe(MIN_TIMEOUT_MS);
    expect(buildPolicy({ timeoutMs: MAX_TIMEOUT_MS * 5 }).timeoutMs).toBe(
      MAX_TIMEOUT_MS,
    );
    expect(buildPolicy({ timeoutMs: 12_345.9 }).timeoutMs).toBe(12_345);
    expect(buildPolicy({ timeoutMs: Number.NaN }).timeoutMs).toBe(
      DEFAULT_TIMEOUT_MS,
    );
    expect(
      buildPolicy({ timeoutMs: "60000" as unknown as number }).timeoutMs,
    ).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("evaluate", () => {
  const policy = buildPolicy();

  it("rejects an empty / whitespace command", () => {
    expect(evaluate("", policy)).toEqual({
      allowed: false,
      reason: "empty_command",
    });
    expect(evaluate("   \t\n", policy)).toEqual({
      allowed: false,
      reason: "empty_command",
    });
  });

  it("blocks the default catastrophic patterns", () => {
    const v = evaluate("yes | sudo apt install foo", policy);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("deny_match");
    expect(v.matchedPattern).toBe("sudo ");
  });

  it("blocks fat-finger rm -rf /", () => {
    const v = evaluate("rm -rf /", policy);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("deny_match");
  });

  it("allows ordinary commands with the default policy", () => {
    expect(evaluate("git status", policy)).toEqual({ allowed: true });
    expect(evaluate("npm test --silent", policy)).toEqual({ allowed: true });
  });

  it("respects the allow-list when configured (allow-list mode)", () => {
    const restricted = buildPolicy({ allow: ["git", "npm test"] });
    expect(evaluate("git status", restricted).allowed).toBe(true);
    expect(evaluate("npm test", restricted).allowed).toBe(true);
    const v = evaluate("python script.py", restricted);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("no_allow_match");
  });

  it("deny rules win over allow rules", () => {
    const restricted = buildPolicy({
      allow: ["bash"],
      deny: ["rm -rf /tmp/important"],
    });
    const v = evaluate("bash -c 'rm -rf /tmp/important'", restricted);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("deny_match");
  });

  it("trims the command before matching so leading whitespace doesn't bypass", () => {
    expect(evaluate("   sudo ls", buildPolicy()).allowed).toBe(false);
  });
});

describe("policyFromEnv", () => {
  it("parses comma-separated env vars and clamps the timeout", () => {
    const p = policyFromEnv({
      MISSION_CONTROL_EXEC_DENY: "curl evil.com,wget badthing",
      MISSION_CONTROL_EXEC_ALLOW: "git, npm,node ",
      MISSION_CONTROL_EXEC_TIMEOUT_MS: "60000",
    } as NodeJS.ProcessEnv);
    expect(p.allow).toEqual(["git", "npm", "node"]);
    expect(p.deny).toContain("curl evil.com");
    expect(p.deny).toContain("wget badthing");
    expect(p.timeoutMs).toBe(60_000);
  });

  it("returns the defaults when no env vars are set", () => {
    const p = policyFromEnv({} as NodeJS.ProcessEnv);
    expect(p.deny).toEqual(DEFAULT_DENY_PATTERNS);
    expect(p.allow).toEqual([]);
    expect(p.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });
});
