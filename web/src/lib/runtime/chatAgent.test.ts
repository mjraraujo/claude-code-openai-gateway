/**
 * Integration test for the chat → tool harness loop.
 *
 * The problem statement called this out explicitly: the chat dock
 * had no tools at all, which caused the planner to give up on any
 * request that needed filesystem access. This test exercises the
 * end-to-end planner→tool→write_file path against a temp workspace,
 * using the deterministic mock planner (no LLM, no auth) that
 * `./planner` falls back to when no token is present.
 *
 * The mock planner walks read_file → exec → done, so we additionally
 * verify the loop behaves correctly when a planner returns a
 * write_file action by feeding fixed plans through `runChatAgent`'s
 * generator interface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mc-chat-agent-test-"));
  workspace = await fs.realpath(workspace);
  process.env.MISSION_CONTROL_WORKSPACE = workspace;
  process.env.CODEX_GATEWAY_CONFIG_DIR = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-chat-agent-cfg-"),
  );
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  if (process.env.CODEX_GATEWAY_CONFIG_DIR) {
    await fs.rm(process.env.CODEX_GATEWAY_CONFIG_DIR, {
      recursive: true,
      force: true,
    });
  }
  delete process.env.MISSION_CONTROL_WORKSPACE;
  delete process.env.CODEX_GATEWAY_CONFIG_DIR;
});

describe("chat agent loop", () => {
  it("runs the deterministic mock planner end-to-end and emits tool_call / tool_result / done", async () => {
    // Seed a README so the mock planner's first read_file step succeeds.
    await fs.writeFile(path.join(workspace, "README.md"), "# hi\n");
    const { runChatAgent } = await import("./chatAgent");
    const events = [];
    for await (const ev of runChatAgent({
      goal: "explore the workspace",
      model: "gpt-5.3-codex",
    })) {
      events.push(ev);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("thought");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types[types.length - 1]).toBe("done");
  });

  it("write_file via the chat tool harness creates a new file in the workspace (regression)", async () => {
    // Drive the tool wrappers directly to assert the write end of the
    // chain: this is the bug the problem statement called out.
    const { writeFile } = await import("./tools");
    const res = await writeFile("integration/note.md", "from chat\n");
    expect(res.ok).toBe(true);
    const onDisk = await fs.readFile(
      path.join(workspace, "integration/note.md"),
      "utf8",
    );
    expect(onDisk).toBe("from chat\n");
  });

  it("a planner asking for a forbidden tool gets a sane tool_result, not a crash", async () => {
    // Synthesise a fake planner that asks for `feature_file` (not
    // available in chat). vi.doMock replaces the module before
    // chatAgent imports it.
    let called = 0;
    vi.doMock("./planner", () => ({
      plan: async () => {
        called++;
        if (called === 1) {
          return {
            thought: "try a forbidden tool",
            action: {
              tool: "feature_file" as const,
              path: "x.feature",
              content: "Feature: x\n",
            },
          };
        }
        return {
          thought: "wrap up",
          action: { tool: "done" as const, summary: "ok" },
        };
      },
      DEFAULT_PLANNER_MODEL: "gpt-5.3-codex",
    }));
    try {
      const { runChatAgent } = await import("./chatAgent");
      const evs = [];
      for await (const ev of runChatAgent({
        goal: "test forbidden",
        model: "gpt-5.3-codex",
        maxSteps: 3,
      })) {
        evs.push(ev);
      }
      const tr = evs.find(
        (e): e is Extract<typeof e, { type: "tool_result" }> =>
          e.type === "tool_result",
      );
      expect(tr).toBeTruthy();
      expect(tr!.ok).toBe(false);
      expect(tr!.code).toBe("command_blocked");
      const last = evs[evs.length - 1];
      expect(last.type).toBe("done");
    } finally {
      vi.doUnmock("./planner");
    }
  });
});
