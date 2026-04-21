import { describe, expect, it } from "vitest";

import { buildClaudeEnv, resolveClaudeBinary, resolveShellBinary } from "./policy";

describe("policy · resolveClaudeBinary", () => {
  it("honours CLAUDE_CODEX_PTY_BIN override even if file doesn't exist", () => {
    const r = resolveClaudeBinary({
      env: { CLAUDE_CODEX_PTY_BIN: "/opt/custom/claude" },
      exists: () => false,
    });
    expect(r).toEqual({
      shell: "/opt/custom/claude",
      args: [],
      fellBack: false,
    });
  });

  it("prefers the bundled claude-codex wrapper when present", () => {
    const r = resolveClaudeBinary({
      env: {},
      exists: (p) => p === "/usr/local/bin/claude-codex",
    });
    expect(r.shell).toBe("/usr/local/bin/claude-codex");
    expect(r.fellBack).toBe(false);
  });

  it("falls back to upstream `claude` with --dangerously-skip-permissions", () => {
    const r = resolveClaudeBinary({
      env: {},
      exists: (p) => p === "/usr/local/bin/claude",
    });
    expect(r.shell).toBe("/usr/local/bin/claude");
    expect(r.args).toContain("--dangerously-skip-permissions");
  });

  it("falls back to bash when nothing else is found", () => {
    const r = resolveClaudeBinary({ env: {}, exists: () => false });
    expect(r.shell).toBe("/bin/bash");
    expect(r.fellBack).toBe(true);
  });
});

describe("policy · resolveShellBinary", () => {
  it("uses $SHELL when it exists", () => {
    const r = resolveShellBinary({
      env: { SHELL: "/usr/bin/zsh" },
      exists: (p) => p === "/usr/bin/zsh",
    });
    expect(r).toEqual({ shell: "/usr/bin/zsh", args: ["-l"] });
  });

  it("falls back to /bin/bash when $SHELL is missing", () => {
    const r = resolveShellBinary({
      env: {},
      exists: (p) => p === "/bin/bash",
    });
    expect(r).toEqual({ shell: "/bin/bash", args: ["-l"] });
  });

  it("last-resort uses /bin/sh", () => {
    const r = resolveShellBinary({ env: {}, exists: () => false });
    expect(r.shell).toBe("/bin/sh");
  });
});

describe("policy · buildClaudeEnv", () => {
  it("strips /v1/messages from gatewayUrl when setting ANTHROPIC_BASE_URL", () => {
    const env = buildClaudeEnv({}, "http://127.0.0.1:18923/v1/messages");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:18923");
  });

  it("leaves origin-only URLs unchanged", () => {
    const env = buildClaudeEnv({}, "http://127.0.0.1:18923");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:18923");
  });

  it("injects a dummy API key when one is not already set", () => {
    const env = buildClaudeEnv({}, "http://x");
    expect(env.ANTHROPIC_API_KEY).toBe("claude-codex-dummy-key");
  });

  it("preserves a caller-supplied ANTHROPIC_API_KEY", () => {
    const env = buildClaudeEnv({ ANTHROPIC_API_KEY: "real-key" }, "http://x");
    expect(env.ANTHROPIC_API_KEY).toBe("real-key");
  });

  it("forces TERM=xterm-256color and FORCE_COLOR=1", () => {
    const env = buildClaudeEnv({ TERM: "dumb" }, "http://x");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.FORCE_COLOR).toBe("1");
  });
});
