/**
 * Tests for the auto-drive planner.
 *
 * Live mode requires a valid Codex token and the gateway running; the
 * unit tests target the *mock* path which is what runs in sandboxes
 * and the demo experience. We force `getValidToken` to return null
 * via `vi.mock` so `plan()` deterministically takes the mock branch.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Stub out the auth storage layer so the planner falls into mock mode.
vi.mock("@/lib/auth/storage", () => ({
  getValidToken: async () => null,
  getOrCreateSessionApiKey: async () => "sk-test",
}));

import { plan } from "./planner";
import type { AutoDriveStep } from "./store";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planner · mock mode", () => {
  it("starts by reading README.md when there are no prior steps", async () => {
    const p = await plan({
      goal: "explore the repo",
      steps: [],
      maxStepsRemaining: 5,
    });
    expect(p.action.tool).toBe("read_file");
    if (p.action.tool === "read_file") {
      expect(p.action.path).toBe("README.md");
    }
    expect(typeof p.thought).toBe("string");
    expect(p.thought.length).toBeGreaterThan(0);
  });

  it("issues an exec listing once the readme has been read", async () => {
    const steps: AutoDriveStep[] = [
      {
        index: 0,
        at: Date.now(),
        kind: "tool",
        text: "read_file README.md",
        data: { tool: "read_file" },
      },
      {
        index: 1,
        at: Date.now(),
        kind: "tool_result",
        text: "# project",
      },
    ];
    const p = await plan({ goal: "explore", steps, maxStepsRemaining: 4 });
    expect(p.action.tool).toBe("exec");
    if (p.action.tool === "exec") {
      expect(p.action.command).toMatch(/ls/);
    }
  });

  it("terminates with done after the read+exec pair", async () => {
    const steps: AutoDriveStep[] = [
      {
        index: 0,
        at: 1,
        kind: "tool",
        text: "read_file README.md",
        data: { tool: "read_file" },
      },
      { index: 1, at: 2, kind: "tool_result", text: "ok" },
      {
        index: 2,
        at: 3,
        kind: "tool",
        text: "exec ls",
        data: { tool: "exec" },
      },
      { index: 3, at: 4, kind: "tool_result", text: "files…" },
    ];
    const p = await plan({ goal: "explore", steps, maxStepsRemaining: 2 });
    expect(p.action.tool).toBe("done");
    if (p.action.tool === "done") {
      expect(p.action.summary).toMatch(/mock planner done/);
    }
  });
});
